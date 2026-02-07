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

const toMinutes = (value) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

const showMessage = (text, isError = true) => {
  message.textContent = text;
  message.style.color = isError ? "#d9480f" : "#2b8a3e";
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
};

const requestSchedule = async (nextRequests) => {
  const response = await fetch("/api/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: nextRequests }),
  });
  if (!response.ok) {
    throw new Error("Backend error");
  }
  return response.json();
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const course = nameInput.value.trim();

  if (!course) {
    showMessage("Please select a course code.");
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
    showMessage("Course added to your timetable.", false);
    form.reset();
    render();
  } catch (error) {
    showMessage("Unable to reach the backend.");
  }
});

rulesHint.textContent =
  "Pick a course code and we will auto-schedule the required sections.";
loadCourseSuggestions();
render();
