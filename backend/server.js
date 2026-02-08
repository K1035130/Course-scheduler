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

const scheduleCourses = (requests) => {
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
    return { course: request.course, options: result.combinations };
  });

  const failed = courseOptions.find((option) => option.error);
  if (failed) {
    return { status: "error", message: failed.error };
  }

  const resolved = [];

  const dfs = (index, meetings) => {
    if (index >= courseOptions.length) {
      resolved.push(...meetings);
      return true;
    }
    const { options } = courseOptions[index];
    for (const option of options) {
      if (!hasConflict(meetings, option.meetings)) {
        if (dfs(index + 1, [...meetings, ...option.meetings])) {
          return true;
        }
      }
    }
    return false;
  };

  const success = dfs(0, []);
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

  return { status: "ok", timetable };
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
        const result = scheduleCourses(requests);
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
