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
  aiStatus.textContent = text;
  aiStatus.style.color = isError ? "#d9480f" : "";
};

const renderAiSuggestions = (suggestions) => {
  if (!aiSuggestionsEl) return;
  aiSuggestionsEl.innerHTML = "";
  (Array.isArray(suggestions) ? suggestions : []).forEach((s) => {
    const li = document.createElement("li");
    li.textContent = String(s);
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
    throw new Error(payload?.message || "AI request failed");
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
    const response = await fetch("/data/sections.json");
    if (!response.ok) {
      throw new Error("Unable to load course list");
    }
    const data = await response.json();
    const courses = Array.from(
      new Set(data.map((section) => section.course).filter(Boolean))
    ).sort();
    updateSuggestions(courses);
    ruleStatus.textContent =
      "Course types and sections are validated by the backend.";
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
    setAiStatus("Generating suggestions...");
    renderAiSuggestions([]);

    try {
      const { suggestions, notes } = await requestAiSuggestions();
      renderAiSuggestions(suggestions);
      setAiStatus(notes || "");
    } catch (err) {
      setAiStatus(err?.message || "Unable to reach AI endpoint.", true);
    } finally {
      aiSuggestBtn.disabled = false;
    }
  });
}
