const form = document.getElementById("course-form");
const nameInput = document.getElementById("course-name");
const message = document.getElementById("form-message");
const grid = document.getElementById("schedule-grid");
const emptyState = document.getElementById("empty-state");
const summary = document.getElementById("summary");
const ruleStatus = document.getElementById("rule-status");
const rulesHint = document.getElementById("rules-hint");
const metricCount = document.getElementById("metric-count");
const metricHours = document.getElementById("metric-hours");
const suggestionList = document.getElementById("course-suggestions");
const selectedCoursesList = document.getElementById("selected-courses");
const selectedEmpty = document.getElementById("selected-empty");

// AI suggestions UI (optional; only works if index.html includes these ids)
const aiSuggestBtn = document.getElementById("ai-suggest-btn");
const aiStatus = document.getElementById("ai-status");
const aiSuggestionsEl = document.getElementById("ai-suggestions");

const dayLabels = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

let requests = [];
let timetable = [];


const normalizeCourse = (value) => String(value || "").trim().toUpperCase();

const readPreferencesFromUI = () => {
  const prefs = {};

  const noBefore = document.getElementById("pref-no-before");
  if (noBefore && noBefore.checked) {
    const t = (document.getElementById("pref-no-before-time")?.value || "").trim();
    prefs.noClassBefore = t || "10:00";
  }

  const noAfter = document.getElementById("pref-no-after");
  if (noAfter && noAfter.checked) {
    const t = (document.getElementById("pref-no-after-time")?.value || "").trim();
    prefs.noClassAfter = t || "18:00";
  }

  const dayChecks = Array.from(document.querySelectorAll(".pref-day"));
  const blockedDays = dayChecks.filter((el) => el.checked).map((el) => el.value);
  if (blockedDays.length) {
    prefs.noClassOnDays = blockedDays;
  }

  const maxEl = document.getElementById("pref-max-continuous");
  if (maxEl) {
    const v = Number(maxEl.value);
    if (Number.isFinite(v) && v > 0) {
      prefs.maxContinuousHours = v;
    }
  }

  return prefs;
};

const toMinutes = (value) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

const showMessage = (text, isError = true) => {
  message.textContent = text;
  message.style.color = isError ? "#d9480f" : "#2b8a3e";
};

const setAiStatus = (text, isError = false) => {
  if (!aiStatus) return;

  const raw = String(text || "");

  // Make status user-friendly (avoid dumping long stack traces / API payloads)
  const normalize = (msg) => {
    const s = String(msg || "").trim();
    if (!s) return "";

    // Common Gemini / backend errors -> short messages
    const lower = s.toLowerCase();
    if (lower.includes("exceeded your current quota") || lower.includes("quota exceeded")) {
      return "AI request limit reached. Please try again later or upgrade your plan.";
    }
    if (lower.includes("not found") && lower.includes("models/")) {
      return "The selected AI model is not supported. Please switch to an available Gemini model.";
    }
    if (lower.includes("api key") && (lower.includes("missing") || lower.includes("invalid"))) {
      return "AI API key is missing or invalid. Please check GEMINI_API_KEY in your .env file.";
    }

    // Truncate overly long messages
    const oneLine = s.replace(/\s+/g, " ");
    return oneLine.length > 140 ? oneLine.slice(0, 140) + "…" : oneLine;
  };

  const friendly = normalize(raw);

  // Hide the status element entirely when there's nothing meaningful to show
  if (!friendly) {
    aiStatus.textContent = "";
    aiStatus.style.display = "none";
    return;
  }

  aiStatus.style.display = "block";

  aiStatus.textContent = friendly;
  aiStatus.style.color = isError ? "#d9480f" : "";
};

const renderAiSuggestions = (suggestions) => {
  if (!aiSuggestionsEl) return;

  // Make the list look nicer without needing extra CSS
  aiSuggestionsEl.innerHTML = "";
  aiSuggestionsEl.style.margin = "8px 0 0";
  aiSuggestionsEl.style.paddingLeft = "18px";
  aiSuggestionsEl.style.listStyle = "decimal";

  // Some Gemini responses (or our fallback parser) can leak code fences / JSON scaffolding.
  // We aggressively clean that so the UI stays readable for users.
  const cleanOne = (s) => {
    let t = String(s ?? "").trim();
    if (!t) return "";

    // Drop common scaffolding/noise lines
    const lower = t.toLowerCase();
    if (lower.startsWith("```")) return "";
    if (lower === "json" || lower === "```json") return "";
    if (t === "{" || t === "}" || t === "[" || t === "]") return "";
    if (lower.includes("model did not return json")) return "";
    if (lower === "\"suggestions\":" || lower.startsWith("\"suggestions\"")) return "";

    // Remove leading bullet markers if they sneak in
    t = t.replace(/^[-*•]+\s+/, "");

    // Remove stray quotes / trailing commas from JSON-ish lines
    t = t.replace(/^"/, "").replace(/",?$/, "");

    // Collapse whitespace
    t = t.replace(/\s+/g, " ").trim();

    return t;
  };

  const arrRaw = Array.isArray(suggestions) ? suggestions : [];
  const cleaned = arrRaw.map(cleanOne).filter(Boolean);

  if (!cleaned.length) {
    const li = document.createElement("li");
    li.textContent = "No suggestions available.";
    li.style.opacity = "0.75";
    li.style.fontStyle = "italic";
    aiSuggestionsEl.appendChild(li);
    return;
  }

  cleaned.forEach((s) => {
    const li = document.createElement("li");
    li.textContent = s;
    li.style.margin = "6px 0";
    li.style.lineHeight = "1.35";
    aiSuggestionsEl.appendChild(li);
  });
};

const requestAiSuggestions = async () => {
  const selectedCourses = requests.map((r) => r.course);
  const preferences = readPreferencesFromUI();

  const response = await fetch("/api/ai/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selectedCourses,
      timetable,
      preferences,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.message || payload?.error || "AI request failed";
    throw new Error(msg);
  }

  return {
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
    notes: payload.notes || "",
  };
};

const updateSuggestions = (items) => {
  suggestionList.innerHTML = "";
  items.forEach((course) => {
    const option = document.createElement("option");
    option.value = course;
    suggestionList.appendChild(option);
  });
};

const loadCourseSuggestions = async () => {
  try {
    const response = await fetch("/api/courses");
    if (!response.ok) {
      throw new Error("Unable to load course list");
    }
    const payload = await response.json().catch(() => ({}));
    const courses = Array.isArray(payload.courses) ? payload.courses : [];
    updateSuggestions(courses);
    ruleStatus.textContent =
      "Suggestions are created based on current choosen courses.";
  } catch (error) {
    updateSuggestions([]);
    ruleStatus.textContent = "Course list unavailable right now.";
  }
};

const render = () => {
  grid.innerHTML = "";
  selectedCoursesList.innerHTML = "";

  const grouped = {};
  Object.keys(dayLabels).forEach((day) => {
    grouped[day] = [];
  });
  timetable.forEach((entry) => {
    if (!grouped[entry.day]) {
      grouped[entry.day] = [];
    }
    grouped[entry.day].push(entry);
  });
  Object.values(grouped).forEach((items) =>
    items.sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
  );

  Object.entries(dayLabels).forEach(([dayKey, label]) => {
    const column = document.createElement("div");
    column.className = "day-column";

    const title = document.createElement("div");
    title.className = "day-title";
    title.textContent = label;

    column.appendChild(title);

    grouped[dayKey].forEach((entry) => {
      const item = document.createElement("div");
      item.className = "course-item";

      const meta = document.createElement("div");
      meta.className = "course-meta";

      const name = document.createElement("div");
      name.className = "course-name";
      name.textContent = `${entry.course} ${entry.component} ${entry.option}`;

      const type = document.createElement("span");
      type.className = "course-type";
      type.textContent = entry.component;

      const time = document.createElement("div");
      time.className = "course-time";
      time.textContent = `${entry.start} - ${entry.end}`;

      meta.appendChild(name);
      meta.appendChild(type);
      item.appendChild(meta);
      item.appendChild(time);
      column.appendChild(item);
    });

    grid.appendChild(column);
  });

  const totalMinutes = timetable.reduce(
    (sum, entry) => sum + (toMinutes(entry.end) - toMinutes(entry.start)),
    0
  );
  const totalHours = Math.round(totalMinutes / 60);
  summary.textContent = timetable.length
    ? `${requests.length} courses added · ${totalHours} hours per week`
    : "";
  metricCount.textContent = requests.length;
  metricHours.textContent = totalHours;
  emptyState.style.display = timetable.length ? "none" : "block";

  requests.forEach((request) => {
    const item = document.createElement("li");

    const label = document.createElement("span");
    label.textContent = request.course;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => removeCourse(request.course));

    item.appendChild(label);
    item.appendChild(btn);
    selectedCoursesList.appendChild(item);
  });
  selectedEmpty.style.display = requests.length ? "none" : "block";
};

const requestSchedule = async (nextRequests) => {
  const preferences = readPreferencesFromUI();
  const response = await fetch("/api/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: nextRequests, preferences }),
  });
  if (!response.ok) {
    // backend returns JSON with message; try to parse for better feedback
    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      // ignore
    }
    const msg = payload?.message || "Backend error";
    throw new Error(msg);
  }
  return response.json();
};

const removeCourse = async (courseToRemove) => {
  const target = normalizeCourse(courseToRemove);
  const nextRequests = requests.filter(
    (request) => normalizeCourse(request.course) !== target
  );

  try {
    const result = await requestSchedule(nextRequests);
    if (result.status !== "ok") {
      showMessage(result.message || "Unable to update timetable.");
      return;
    }
    requests = nextRequests;
    timetable = result.timetable || [];

    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) {
      showMessage(warnings.join(" "), false);
    } else {
      showMessage("Course removed.", false);
    }

    render();
  } catch (error) {
    showMessage("Unable to reach the backend.");
  }
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const course = normalizeCourse(nameInput.value);

  if (!course) {
    showMessage("Please select a course code.");
    return;
  }

  if (requests.some((request) => normalizeCourse(request.course) === course)) {
    showMessage("This course is already in your timetable.");
    return;
  }

  const nextRequests = [...requests, { course }];

  try {
    const result = await requestSchedule(nextRequests);
    if (result.status === "conflict") {
      showMessage(result.message || "These courses conflict.");
      return;
    }
    if (result.status !== "ok") {
      showMessage(result.message || "Unable to build timetable.");
      return;
    }
    requests = nextRequests;
    timetable = result.timetable || [];

    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) {
      showMessage(warnings.join(" "), false);
    } else {
      showMessage("Course added to your timetable.", false);
    }

    form.reset();
    render();
  } catch (error) {
    showMessage("Unable to reach the backend.");
  }
});


const prefsPanel = document.getElementById("prefs");
if (prefsPanel) {
  prefsPanel.addEventListener("change", async () => {
    if (!requests.length) return;
    try {
      const result = await requestSchedule(requests);
      if (result.status === "ok") {
        timetable = result.timetable || [];
        const warnings = Array.isArray(result.warnings) ? result.warnings : [];
        if (warnings.length) {
          showMessage(warnings.join(" "), false);
        } else {
          showMessage("Preferences updated.", false);
        }
        render();
      } else {
        showMessage(result.message || "Unable to apply preferences.");
      }
    } catch (error) {
      showMessage(error.message || "Unable to reach the backend.");
    }
  });
}

rulesHint.textContent =
  "Pick a course code and we will auto-schedule the required sections.";
loadCourseSuggestions();
render();

// Wire AI button (if present)
if (aiSuggestBtn) {
  aiSuggestBtn.addEventListener("click", async () => {
    if (!requests.length) {
      setAiStatus("Add at least one course first.", true);
      renderAiSuggestions([]);
      return;
    }

    aiSuggestBtn.disabled = true;
    setAiStatus("Generating suggestions…", false);
    renderAiSuggestions([]);

    try {
      const { suggestions, notes } = await requestAiSuggestions();
      renderAiSuggestions(suggestions);
      // Notes are for dev/debug; don't show them to users.
      setAiStatus("", false);
    } catch (err) {
      setAiStatus(err?.message || "Unable to reach AI endpoint.", true);
      // Also clear any stale suggestions UI if an error occurs
      renderAiSuggestions([]);
    } finally {
      aiSuggestBtn.disabled = false;
    }
  });
}
