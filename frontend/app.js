const form = document.getElementById("course-form");
const nameInput = document.getElementById("course-name");
const dayInput = document.getElementById("course-day");
const startInput = document.getElementById("start-time");
const endInput = document.getElementById("end-time");
const message = document.getElementById("form-message");
const grid = document.getElementById("schedule-grid");
const emptyState = document.getElementById("empty-state");
const summary = document.getElementById("summary");

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

      const name = document.createElement("div");
      name.className = "course-name";
      name.textContent = course.name;

      const time = document.createElement("div");
      time.className = "course-time";
      time.textContent = `${course.startLabel} - ${course.endLabel}`;

      item.appendChild(name);
      item.appendChild(time);
      column.appendChild(item);
    });

    grid.appendChild(column);
  });

  const totalMinutes = courses.reduce(
    (sum, course) => sum + (course.end - course.start),
    0
  );
  summary.textContent = courses.length
    ? `已排 ${courses.length} 门课 · 共 ${Math.round(
        totalMinutes / 60
      )} 小时`
    : "";

  emptyState.style.display = courses.length ? "none" : "block";
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const day = dayInput.value;
  const startValue = startInput.value;
  const endValue = endInput.value;

  if (!name || !startValue || !endValue) {
    showMessage("please fill in all fields.");
    return;
  }

  const start = toMinutes(startValue);
  const end = toMinutes(endValue);

  if (start >= end) {
    showMessage("The end time must be later than the start time.");
    return;
  }

  if (hasConflict(day, start, end)) {
    showMessage("This time slot conflicts with your selected course. Please adjust accordingly.");
    return;
  }

  courses.push({
    name,
    day,
    start,
    end,
    startLabel: formatTime(startValue),
    endLabel: formatTime(endValue),
  });

  showMessage("The course has been added to your timetable.", false);
  form.reset();
  dayInput.value = day;
  render();
});

render();
