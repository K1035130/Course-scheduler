const http = require("http");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

const loadJson = (filePath) =>
  JSON.parse(fs.readFileSync(filePath, "utf-8"));

const courseRules = loadJson(path.join(DATA_DIR, "courseRules.json"));
const sections = loadJson(path.join(DATA_DIR, "sections.json"));

const sectionsByCourse = sections.reduce((acc, section) => {
  if (!section.course) return acc;
  if (!acc[section.course]) acc[section.course] = [];
  acc[section.course].push(section);
  return acc;
}, {});

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
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

    // Apply HARD constraints (noClassBefore / noClassOnDays)
    const filteredOptions = (result.combinations || []).filter((combo) =>
      optionPassesHardConstraints(combo.meetings || [], preferences)
    );

    if (!filteredOptions.length) {
      const reasons = [];
      if (preferences.noClassBefore)
        reasons.push(`noClassBefore=${preferences.noClassBefore}`);
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
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
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

  if (req.url.startsWith("/data/")) {
    const dataPath = path.join(DATA_DIR, req.url.replace("/data/", ""));
    if (!dataPath.startsWith(DATA_DIR) || !fs.existsSync(dataPath)) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(dataPath);
    const contentType = contentTypeByExt[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(dataPath).pipe(res);
    return;
  }

  serveStatic(req, res);
});

server.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
