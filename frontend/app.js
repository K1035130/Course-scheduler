const form = document.getElementById("course-form");
const nameInput = document.getElementById("course-name");
const typeInput = document.getElementById("course-type");
const sectionInput = document.getElementById("course-section");
const dayInput = document.getElementById("course-day");
const startInput = document.getElementById("start-time");
const endInput = document.getElementById("end-time");
const message = document.getElementById("form-message");
const grid = document.getElementById("schedule-grid");
const emptyState = document.getElementById("empty-state");
const summary = document.getElementById("summary");
const ruleStatus = document.getElementById("rule-status");
const rulesHint = document.getElementById("rules-hint");
const sectionHint = document.getElementById("section-hint");
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

const courses = [];
let courseRules = {};
let rulesLoaded = false;
let sectionCourses = new Set();
let sectionsLoaded = false;
let sectionsByCourse = new Map();
let sectionById = new Map();

const toMinutes = (value) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

const formatTime = (value) => {
  if (!value) return "";
  const [hours, minutes] = value.split(":");
  return `${hours}:${minutes}`;
};

const showMessage = (text, isError = true) => {
  message.textContent = text;
  message.style.color = isError ? "#d9480f" : "#2b8a3e";
};

const updateTypeOptions = (types) => {
  typeInput.innerHTML = "";
  types.forEach((type) => {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    typeInput.appendChild(option);
  });
};

const updateSuggestions = (items) => {
  suggestionList.innerHTML = "";
  items.forEach((course) => {
    const option = document.createElement("option");
    option.value = course;
    suggestionList.appendChild(option);
  });
};

const updateSectionOptions = (sections) => {
  sectionInput.innerHTML = "";
  sections.forEach((section) => {
    const option = document.createElement("option");
    option.value = section.id;
    option.textContent = section.label;
    sectionInput.appendChild(option);
  });
};

const setManualTimeEnabled = (enabled) => {
  dayInput.disabled = !enabled;
  startInput.disabled = !enabled;
  endInput.disabled = !enabled;
};

const formatMeetingLabel = (meeting) => {
  const dayLabel = dayLabels[meeting.day] ?? meeting.day;
  return `${dayLabel} ${meeting.start}-${meeting.end}`;
};

const buildSectionLabel = (section) => {
  const meetings = (section.meetings || []).map(formatMeetingLabel).join(", ");
  return `${section.component} ${section.option} · ${meetings}`;
};

const setSectionState = (courseName) => {
  if (!sectionsLoaded) {
    updateSectionOptions([{ id: "loading", label: "Loading sections..." }]);
    sectionInput.disabled = true;
    sectionHint.textContent = "Loading section times. Please wait.";
    setManualTimeEnabled(false);
    return;
  }

  const trimmed = courseName.trim();
  if (!trimmed || !sectionCourses.has(trimmed)) {
    updateSectionOptions([{ id: "manual", label: "Manual entry" }]);
    sectionInput.disabled = true;
    sectionHint.textContent =
      "Course not in the list. Enter the day and time manually.";
    setManualTimeEnabled(true);
    return;
  }

  const sections = sectionsByCourse.get(trimmed) || [];
  if (!sections.length) {
    updateSectionOptions([{ id: "none", label: "No sections available" }]);
    sectionInput.disabled = true;
    sectionHint.textContent = "No section times found for this course.";
    setManualTimeEnabled(true);
    return;
  }

  updateSectionOptions(sections);
  sectionInput.disabled = false;
  sectionHint.textContent = "Select a section time for this course.";
  setManualTimeEnabled(false);
};

const setTypeState = (courseName) => {
  if (!rulesLoaded) {
    updateTypeOptions(["Loading rules..."]);
    typeInput.disabled = true;
    rulesHint.textContent = "Loading course rules. Please wait.";
    return;
  }

  if (!sectionsLoaded) {
    updateTypeOptions(["Loading courses..."]);
    typeInput.disabled = true;
    rulesHint.textContent = "Loading courses. Please wait.";
    return;
  }

  const trimmed = courseName.trim();
  if (!trimmed) {
    updateTypeOptions(["Select a course title first"]);
    typeInput.disabled = true;
    rulesHint.textContent = "Start typing to select a course from the list.";
    return;
  }

  if (!sectionCourses.has(trimmed)) {
    updateTypeOptions(["Custom"]);
    typeInput.disabled = false;
    rulesHint.textContent =
      "Course not in the list. It will be added as a custom entry.";
    return;
  }

  const allowed = courseRules[trimmed];
  if (!allowed) {
    updateTypeOptions(["No rules found"]);
    typeInput.disabled = true;
    rulesHint.textContent = "No course rules found for this title.";
    return;
  }

  updateTypeOptions(allowed);
  typeInput.disabled = false;
  rulesHint.textContent = `Allowed types: ${allowed.join(", ")}`;
};

const loadCourseRules = async () => {
  try {
    const response = await fetch("../backend/data/courseRules.json");
    if (!response.ok) {
      throw new Error("Unable to load rules");
    }
    courseRules = await response.json();
    rulesLoaded = true;
    ruleStatus.textContent = "Course types are limited by the rules database.";
  } catch (error) {
    rulesLoaded = true;
    courseRules = {};
    ruleStatus.textContent =
      "Course rules could not be loaded. Please try again later.";
  }
  setTypeState(nameInput.value);
};

const loadCourseSections = async () => {
  try {
    const response = await fetch("../backend/data/sections.json");
    if (!response.ok) {
      throw new Error("Unable to load courses");
    }
    const data = await response.json();
    sectionsByCourse = new Map();
    sectionById = new Map();
    data.forEach((section, index) => {
      if (!section || !section.course) return;
      const entry = {
        ...section,
        id: String(index),
      };
      entry.label = buildSectionLabel(entry);
      if (!sectionsByCourse.has(entry.course)) {
        sectionsByCourse.set(entry.course, []);
      }
      sectionsByCourse.get(entry.course).push(entry);
      sectionById.set(entry.id, entry);
    });
    sectionCourses = new Set(Array.from(sectionsByCourse.keys()).sort());
    updateSuggestions(Array.from(sectionCourses));
    sectionsLoaded = true;
  } catch (error) {
    sectionsLoaded = true;
    sectionCourses = new Set();
    sectionsByCourse = new Map();
    sectionById = new Map();
    updateSuggestions([]);
    rulesHint.textContent = "Course list unavailable right now.";
  }
  setTypeState(nameInput.value);
  setSectionState(nameInput.value);
};

const hasConflict = (day, start, end) =>
  courses.some((course) =>
    course.day === day && start < course.end && end > course.start
  );

const groupByDay = () => {
  const grouped = {};
  Object.keys(dayLabels).forEach((day) => {
    grouped[day] = [];
  });
  courses.forEach((course) => {
    grouped[course.day].push(course);
  });
  Object.values(grouped).forEach((items) =>
    items.sort((a, b) => a.start - b.start)
  );
  return grouped;
};

const render = () => {
  const grouped = groupByDay();
  grid.innerHTML = "";

  Object.entries(dayLabels).forEach(([dayKey, label]) => {
    const column = document.createElement("div");
    column.className = "day-column";

    const title = document.createElement("div");
    title.className = "day-title";
    title.textContent = label;

    column.appendChild(title);

    grouped[dayKey].forEach((course) => {
      const item = document.createElement("div");
      item.className = "course-item";

      const meta = document.createElement("div");
      meta.className = "course-meta";

      const name = document.createElement("div");
      name.className = "course-name";
      name.textContent = course.name;

      const type = document.createElement("span");
      type.className = "course-type";
      type.textContent = course.type;

      const time = document.createElement("div");
      time.className = "course-time";
      time.textContent = `${course.startLabel} - ${course.endLabel}`;

      meta.appendChild(name);
      meta.appendChild(type);
      item.appendChild(meta);
      item.appendChild(time);
      column.appendChild(item);
    });

    grid.appendChild(column);
  });

  const totalMinutes = courses.reduce(
    (sum, course) => sum + (course.end - course.start),
    0
  );
  const totalHours = Math.round(totalMinutes / 60);
  summary.textContent = courses.length
    ? `${courses.length} classes added · ${totalHours} hours per week`
    : "";
  metricCount.textContent = courses.length;
  metricHours.textContent = totalHours;

  emptyState.style.display = courses.length ? "none" : "block";
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const type = typeInput.value;
  const day = dayInput.value;
  const startValue = startInput.value;
  const endValue = endInput.value;

  if (!name) {
    showMessage("Please fill in all fields.");
    return;
  }

  const isListedCourse = sectionCourses.has(name);

  if (!isListedCourse && (!startValue || !endValue)) {
    showMessage("Please fill in all fields.");
    return;
  }

  if (isListedCourse) {
    if (!courseRules[name]) {
      showMessage("No course rules found for this title.");
      return;
    }

    if (!courseRules[name].includes(type)) {
      showMessage("Please select a valid course type.");
      return;
    }
  }

  if (isListedCourse) {
    if (sectionInput.disabled) {
      showMessage("Select a section time for this course.");
      return;
    }
    const selectedId = sectionInput.value;
    const section = sectionById.get(selectedId);
    if (!section || !section.meetings || !section.meetings.length) {
      showMessage("Selected section has no meeting times.");
      return;
    }

    const normalizedMeetings = section.meetings.map((meeting) => ({
      day: meeting.day,
      start: toMinutes(meeting.start),
      end: toMinutes(meeting.end),
      startLabel: formatTime(meeting.start),
      endLabel: formatTime(meeting.end),
    }));

    if (normalizedMeetings.some((m) => m.start >= m.end)) {
      showMessage("Section time is invalid.");
      return;
    }

    if (normalizedMeetings.some((m) => hasConflict(m.day, m.start, m.end))) {
      showMessage("This section conflicts with an existing course.");
      return;
    }

    normalizedMeetings.forEach((meeting) => {
      courses.push({
        name,
        type,
        day: meeting.day,
        start: meeting.start,
        end: meeting.end,
        startLabel: meeting.startLabel,
        endLabel: meeting.endLabel,
      });
    });
  } else {
    const start = toMinutes(startValue);
    const end = toMinutes(endValue);

    if (start >= end) {
      showMessage("End time must be later than start time.");
      return;
    }

    if (hasConflict(day, start, end)) {
      showMessage("This time slot conflicts with an existing course.");
      return;
    }

    courses.push({
      name,
      type,
      day,
      start,
      end,
      startLabel: formatTime(startValue),
      endLabel: formatTime(endValue),
    });
  }

  showMessage("Course added to your timetable.", false);
  form.reset();
  dayInput.value = day;
  setTypeState("");
  setSectionState("");
  render();
});

nameInput.addEventListener("input", (event) => {
  setTypeState(event.target.value);
  setSectionState(event.target.value);
});

loadCourseRules();
loadCourseSections();
render();
