// Load environment variables from .env (local dev)
require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { connectToMongo, getDb } = require("./db/mongo");

const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

let courseRules = {};
let sections = [];
let sectionsByCourse = {};

const COURSE_RULES_COLLECTION =
  process.env.COURSE_RULES_COLLECTION;
// Fallback collection probe (disabled by request)
// const COURSE_RULES_COLLECTIONS = (
//   process.env.COURSE_RULES_COLLECTIONS ||
//   [
//     "CorsesRules",
//     "CourseRules",
//     "CoursesRules",
//     "CouseRules",
//     "CourseRule",
//   ].join(",")
// )
//   .split(",")
//   .map((s) => s.trim())
//   .filter(Boolean);
const SECTIONS_COLLECTION = process.env.SECTIONS_COLLECTION || "Sections";

const getCourseList = () => {
  const fromRules = Object.keys(courseRules || {}).filter(Boolean);
  if (fromRules.length) return fromRules.sort();

  const fromSections = Object.keys(sectionsByCourse || {}).filter(Boolean);
  return fromSections.sort();
};

const buildSectionsByCourse = (items) =>
  items.reduce((acc, section) => {
    if (!section.course) return acc;
    if (!acc[section.course]) acc[section.course] = [];
    acc[section.course].push(section);
    return acc;
  }, {});

const loadDataFromMongo = async () => {
  const db = getDb();
  let courseRulesRows = await db
    .collection(COURSE_RULES_COLLECTION)
    .find({})
    .toArray();

  let usedCourseRulesCollection = COURSE_RULES_COLLECTION;
  // if (!courseRulesRows.length) {
  //   for (const name of COURSE_RULES_COLLECTIONS) {
  //     if (name === COURSE_RULES_COLLECTION) continue;
  //     const rows = await db.collection(name).find({}).toArray();
  //     if (rows.length) {
  //       courseRulesRows = rows;
  //       usedCourseRulesCollection = name;
  //       break;
  //     }
  //   }
  // }
  const sectionsRows = await db
    .collection(SECTIONS_COLLECTION)
    .find({})
    .toArray();

  courseRules = courseRulesRows.reduce((acc, row) => {
    if (row?.course && Array.isArray(row?.required)) {
      acc[String(row.course)] = row.required.map((v) => String(v));
    }
    return acc;
  }, {});

  sections = sectionsRows.map((row) => ({
    course: row?.course,
    component: row?.component,
    option: row?.option,
    meetings: Array.isArray(row?.meetings) ? row.meetings : [],
  }));

  sectionsByCourse = buildSectionsByCourse(sections);

  console.log(
    `[MongoDB] loaded ${Object.keys(courseRules).length} course rules, ${sections.length} sections`
  );
  console.log(
    `[MongoDB] course rules collection used: ${usedCourseRulesCollection}`
  );
};

const contentTypeByExt = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
};

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
};

// ===== AI (Gemini) helpers =====
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const normalizeGeminiModel = (value) => {
  const v = String(value || "").trim();
  if (!v) return "";
  // Accept either "gemini-..." or "models/gemini-..." and normalize to the bare model id.
  return v.startsWith("models/") ? v.slice("models/".length) : v;
};

// Use a fast/cheap default; allow override via env.
const GEMINI_MODEL = normalizeGeminiModel(process.env.GEMINI_MODEL) || "gemini-2.0-flash";

// Tiny startup sanity check (helps debug Missing GEMINI_API_KEY)
console.log("[AI] GEMINI_API_KEY loaded?", !!GEMINI_API_KEY);
console.log("[AI] GEMINI_MODEL:", GEMINI_MODEL);

const safeJsonParse = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const buildSuggestionPrompt = ({ selectedCourses, timetable, preferences }) => {
  const courses = Array.isArray(selectedCourses) ? selectedCourses : [];
  const tt = Array.isArray(timetable) ? timetable : [];
  const prefs = preferences && typeof preferences === "object" ? preferences : {};

  // Keep prompt small + structured for hackathon reliability
  return `You are an academic course planning assistant for UBC students.

INPUT:
- Selected courses (course codes): ${courses.map((c) => String(c)).join(", ") || "(none)"}
- Current timetable entries (JSON): ${JSON.stringify(tt)}
- Preferences (JSON): ${JSON.stringify(prefs)}

TASK:
Return 4-7 actionable suggestions to improve the student's schedule/plan.

Rules:
- Be concise.
- Do NOT invent specific degree requirements unless explicitly present in the input.
- You MAY suggest general next-steps (e.g., check prerequisites, balance workload, avoid early classes).
- You MUST NOT suggest specific sections or schedules (e.g., "take MATH 100 on Mon/Wed 10am").
- Do NOT suggest adding other section/LAB/DIS for a course that already have.
- Output MUST be valid JSON with shape:
  {"suggestions": ["...", "..."], "notes": "optional"}
- only give suggestions about which cources to add/drop
`;
};

const callGemini = async (prompt) => {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      status: 500,
      error:
        "Missing GEMINI_API_KEY. Create backend/.env and set GEMINI_API_KEY=... then restart the server.",
    };
  }

  // Avoid "cold silence" by timing out.
  const controller = new AbortController();
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 12000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const shouldRetryModel = (status, data) => {
    const msg = String(data?.error?.message || "").toLowerCase();
    // Common cases when a model name is wrong / not available for this endpoint.
    return (
      status === 404 ||
      msg.includes("not found") ||
      msg.includes("is not supported") ||
      msg.includes("unsupported") ||
      msg.includes("invalid argument")
    );
  };

  const extractText = (data) => {
    return (
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text)
        .filter(Boolean)
        .join("\n") ||
      ""
    );
  };

  const doGenerate = async (modelId) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      normalizeGeminiModel(modelId)
    )}:generateContent`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 768,
        },
      }),
      signal: controller.signal,
    });

    const data = await resp.json().catch(() => ({}));
    const text = extractText(data);

    return { resp, data, text };
  };

  // Try the configured model first, then fall back to a few common candidates.
  const candidates = [
    GEMINI_MODEL,
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ]
    .map((m) => normalizeGeminiModel(m))
    .filter(Boolean)
    // de-dupe while preserving order
    .filter((m, i, arr) => arr.indexOf(m) === i);

  let lastError = null;

  try {
    for (let i = 0; i < candidates.length; i++) {
      const modelId = candidates[i];
      const { resp, data, text } = await doGenerate(modelId);

      if (resp.ok) {
        return { ok: true, status: 200, text, raw: data, usedModel: modelId };
      }

      const errMsg =
        data?.error?.message ||
        `Gemini API error (HTTP ${resp.status}).` ||
        "Gemini API error.";

      lastError = {
        ok: false,
        status: resp.status,
        error: errMsg,
        raw: data,
        triedModel: modelId,
      };

      // Only retry on model/endpoint mismatch type errors.
      if (!shouldRetryModel(resp.status, data)) {
        return lastError;
      }
    }

    // All candidates failed.
    return (
      lastError || {
        ok: false,
        status: 500,
        error: "Gemini API request failed.",
      }
    );
  } catch (err) {
    const isTimeout = String(err?.name) === "AbortError";
    return {
      ok: false,
      status: isTimeout ? 504 : 500,
      error: isTimeout
        ? `Gemini request timeout after ${timeoutMs}ms.`
        : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
};

const toMinutes = (value) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

const hasConflict = (currentMeetings, candidateMeetings) =>
  candidateMeetings.some((candidate) =>
    currentMeetings.some(
      (existing) =>
        existing.day === candidate.day &&
        candidate.start < existing.end &&
        candidate.end > existing.start
    )
  );

const normalizePreferences = (prefs) => {
  const raw = prefs && typeof prefs === "object" ? prefs : {};

  const noClassBefore =
    typeof raw.noClassBefore === "string" && raw.noClassBefore.includes(":")
      ? raw.noClassBefore
      : null;

  const noClassAfter =
    typeof raw.noClassAfter === "string" && raw.noClassAfter.includes(":")
      ? raw.noClassAfter
      : null;

  const noClassOnDays = Array.isArray(raw.noClassOnDays)
    ? raw.noClassOnDays.map((d) => String(d || "").trim()).filter(Boolean)
    : [];

  const maxContinuousHours =
    raw.maxContinuousHours == null
      ? null
      : Number.isFinite(Number(raw.maxContinuousHours))
      ? Number(raw.maxContinuousHours)
      : null;

  return {
    noClassBefore, // e.g. "10:00" or null
    noClassAfter, // e.g. "18:00" or null
    noClassOnDays, // e.g. ["Fri"]
    maxContinuousHours, // e.g. 2 or null
  };
};

const optionPassesHardConstraints = (optionMeetings, preferences) => {
  if (preferences.noClassOnDays && preferences.noClassOnDays.length) {
    const blocked = new Set(preferences.noClassOnDays);
    for (const m of optionMeetings || []) {
      if (blocked.has(m.day)) return false;
    }
  }

  if (preferences.noClassBefore) {
    const cutoff = toMinutes(preferences.noClassBefore);
    for (const m of optionMeetings || []) {
      if (m.start < cutoff) return false;
    }
  }

  if (preferences.noClassAfter) {
    const cutoff = toMinutes(preferences.noClassAfter);
    for (const m of optionMeetings || []) {
      if (m.end > cutoff) return false;
    }
  }

  return true;
};

// Treat classes as "continuous" if the gap between adjacent meetings on the same day is <= gapMinutes.
const violatesMaxContinuousHours = (allMeetings, maxHours, gapMinutes = 10) => {
  if (!maxHours || maxHours <= 0) return false;

  const byDay = (allMeetings || []).reduce((acc, m) => {
    (acc[m.day] ||= []).push(m);
    return acc;
  }, {});

  const limit = maxHours * 60;

  for (const day of Object.keys(byDay)) {
    const list = byDay[day].slice().sort((a, b) => a.start - b.start);
    if (list.length === 0) continue;

    let blockStart = list[0].start;
    let blockEnd = list[0].end;

    for (let i = 1; i < list.length; i++) {
      const cur = list[i];
      const gap = cur.start - blockEnd;

      if (gap <= gapMinutes) {
        blockEnd = Math.max(blockEnd, cur.end);
      } else {
        if (blockEnd - blockStart > limit) return true;
        blockStart = cur.start;
        blockEnd = cur.end;
      }
    }

    if (blockEnd - blockStart > limit) return true;
  }

  return false;
};

const buildCourseOptions = (course) => {
  const required = courseRules[course];
  if (!required || !required.length) {
    return { error: `No course rules found for ${course}.` };
  }

  const byComponent = required.reduce((acc, component) => {
    acc[component] = (sectionsByCourse[course] || []).filter(
      (section) => section.component === component
    );
    return acc;
  }, {});

  const missing = required.filter((component) => !byComponent[component].length);
  if (missing.length) {
    return { error: `Missing sections for ${course}: ${missing.join(", ")}` };
  }

  const combinations = [];
  const build = (index, chosen) => {
    if (index >= required.length) {
      const meetings = chosen.flatMap((section) =>
        (section.meetings || []).map((meeting) => ({
          course,
          component: section.component,
          option: section.option,
          day: meeting.day,
          start: toMinutes(meeting.start),
          end: toMinutes(meeting.end),
          startLabel: meeting.start,
          endLabel: meeting.end,
        }))
      );
      combinations.push({ sections: chosen, meetings });
      return;
    }
    const component = required[index];
    byComponent[component].forEach((section) =>
      build(index + 1, [...chosen, section])
    );
  };

  build(0, []);
  return { combinations };
};

const scheduleCourses = (requests, preferencesInput) => {
  const preferences = normalizePreferences(preferencesInput);
  const normalized = (Array.isArray(requests) ? requests : [])
    .map((r) => ({
      course: String(r?.course || "").trim(),
    }))
    .filter((r) => r.course.length > 0);

  // 重复课程直接报错（防止同一门课点两次）
  const seen = new Set();
  const duplicates = new Set();
  for (const r of normalized) {
    if (seen.has(r.course)) duplicates.add(r.course);
    else seen.add(r.course);
  }
  if (duplicates.size > 0) {
    return {
      status: "error",
      message: `Duplicate course(s) in request: ${[...duplicates].join(", ")}`,
    };
  }

  for (const request of normalized) {
    if (!courseRules[request.course]) {
      return { status: "error", message: `Unknown course: ${request.course}.` };
    }
  }

  const courseOptions = normalized.map((request) => {
    const result = buildCourseOptions(request.course);
    if (result.error) {
      return { error: result.error };
    }

    // Apply HARD constraints (noClassBefore / noClassAfter / noClassOnDays)
    const filteredOptions = (result.combinations || []).filter((combo) =>
      optionPassesHardConstraints(combo.meetings || [], preferences)
    );

    if (!filteredOptions.length) {
      const reasons = [];
      if (preferences.noClassBefore)
        reasons.push(`noClassBefore=${preferences.noClassBefore}`);
      if (preferences.noClassAfter)
        reasons.push(`noClassAfter=${preferences.noClassAfter}`);
      if (preferences.noClassOnDays.length)
        reasons.push(`noClassOnDays=${preferences.noClassOnDays.join(",")}`);
      const suffix = reasons.length
        ? ` (after applying ${reasons.join(" and ")})`
        : "";
      return { error: `No valid options remain for ${request.course}${suffix}.` };
    }

    return { course: request.course, options: filteredOptions };
  });

  const failed = courseOptions.find((option) => option.error);
  if (failed) {
    return { status: "error", message: failed.error };
  }

  const resolved = [];

  const dfsStrict = (index, meetings) => {
    if (index >= courseOptions.length) {
      resolved.push(...meetings);
      return true;
    }

    const { options } = courseOptions[index];
    for (const option of options) {
      const nextMeetings = [...meetings, ...(option.meetings || [])];

      if (hasConflict(meetings, option.meetings || [])) continue;

      // Soft constraint: avoid long continuous blocks
      if (
        preferences.maxContinuousHours &&
        violatesMaxContinuousHours(nextMeetings, preferences.maxContinuousHours)
      ) {
        continue;
      }

      if (dfsStrict(index + 1, nextMeetings)) return true;
    }

    return false;
  };

  const dfsRelaxed = (index, meetings) => {
    if (index >= courseOptions.length) {
      resolved.push(...meetings);
      return true;
    }

    const { options } = courseOptions[index];
    for (const option of options) {
      const nextMeetings = [...meetings, ...(option.meetings || [])];

      if (hasConflict(meetings, option.meetings || [])) continue;

      if (dfsRelaxed(index + 1, nextMeetings)) return true;
    }

    return false;
  };

  // First try strict (soft constraint enforced if provided)
  let usedRelaxed = false;
  let success = dfsStrict(0, []);

  // Fallback: relax ONLY the soft constraint
  if (!success) {
    resolved.length = 0;
    usedRelaxed = true;
    success = dfsRelaxed(0, []);
  }

  if (!success) {
    return {
      status: "conflict",
      message: "These courses conflict and cannot be scheduled together.",
    };
  }

  const timetable = resolved.map((entry) => ({
    course: entry.course,
    component: entry.component,
    option: entry.option,
    day: entry.day,
    start: entry.startLabel,
    end: entry.endLabel,
  }));

  timetable.sort((a, b) => {
    if (a.day === b.day) {
      return toMinutes(a.start) - toMinutes(b.start);
    }
    return a.day.localeCompare(b.day);
  });

  const warnings = [];
  if (usedRelaxed && preferences.maxContinuousHours) {
    warnings.push(
      `Could not satisfy maxContinuousHours=${preferences.maxContinuousHours}. Generated a feasible schedule by relaxing it.`
    );
  }

  return {
    status: "ok",
    timetable,
    warnings,
    appliedPreferences: {
      noClassBefore: preferences.noClassBefore,
      noClassAfter: preferences.noClassAfter,
      noClassOnDays: preferences.noClassOnDays,
      maxContinuousHours: preferences.maxContinuousHours,
      softConstraintRelaxed: usedRelaxed,
    },
  };
};

const serveStatic = (req, res) => {
  const requestedPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(FRONTEND_DIR, requestedPath);
  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not Found");
    return true;
  }
  const ext = path.extname(filePath);
  const contentType = contentTypeByExt[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // AI: expose current model configuration (debug helper)
  if (req.url === "/api/ai/models" && req.method === "GET") {
    sendJson(res, 200, {
      status: "ok",
      hasKey: Boolean(GEMINI_API_KEY),
      model: GEMINI_MODEL,
      candidates: [
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
      ],
    });
    return;
  }

  if (req.url === "/api/schedule" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const requests = Array.isArray(payload.requests) ? payload.requests : [];
        const preferences = payload.preferences || {};
        const result = scheduleCourses(requests, preferences);
        sendJson(res, result.status === "ok" ? 200 : 400, result);
      } catch (error) {
        sendJson(res, 400, {
          status: "error",
          message: "Invalid request payload.",
        });
      }
    });
    return;
  }

  if (req.url === "/api/courses" && req.method === "GET") {
    const courses = getCourseList();
    sendJson(res, 200, {
      status: "ok",
      courses,
      source: Object.keys(courseRules || {}).length ? "courseRules" : "sections",
    });
    return;
  }

  if (req.url === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      status: "ok",
      courseRulesCount: Object.keys(courseRules || {}).length,
      sectionsCount: sections.length,
      coursesCount: getCourseList().length,
    });
    return;
  }

  if (req.url === "/api/ai/suggest" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const payload = safeJsonParse(body || "{}", {});

        const selectedCourses = Array.isArray(payload.selectedCourses)
          ? payload.selectedCourses
          : Array.isArray(payload.requests)
          ? payload.requests.map((r) => r?.course).filter(Boolean)
          : [];

        const timetable = Array.isArray(payload.timetable) ? payload.timetable : [];
        const preferences = payload.preferences || {};

        const prompt = buildSuggestionPrompt({
          selectedCourses,
          timetable,
          preferences,
        });

        const result = await callGemini(prompt);
        if (!result.ok) {
          sendJson(res, result.status || 500, {
            status: "error",
            message: result.error || "AI request failed.",
            // Helpful for debugging model/version issues
            details: {
              configuredModel: GEMINI_MODEL,
              triedModel: result.triedModel || null,
              usedModel: result.usedModel || null,
              httpStatus: result.status,
              geminiError: result.raw?.error?.message || null,
            },
          });
          return;
        }

        // Try parse JSON from model; fallback to plain text suggestions
        const parsed = safeJsonParse(result.text, null);
        if (parsed && Array.isArray(parsed.suggestions)) {
          sendJson(res, 200, {
            status: "ok",
            suggestions: parsed.suggestions,
            notes: parsed.notes || "",
          });
          return;
        }

        sendJson(res, 200, {
          status: "ok",
          suggestions: result.text
            ? result.text
                .split(/\n+/)
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 7)
            : [],
          notes: "Model did not return JSON; fallback parsing applied.",
        });
      } catch (error) {
        sendJson(res, 400, {
          status: "error",
          message: "Invalid request payload.",
        });
      }
    });
    return;
  }

  serveStatic(req, res);
});

const startServer = async () => {
  try {
    await connectToMongo();
    await loadDataFromMongo();
  } catch (err) {
    console.error("[MongoDB] startup failed:", err?.message || err);
    process.exit(1);
  }

  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
};

startServer();
