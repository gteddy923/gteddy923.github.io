const entryForm = document.getElementById("entry-form");
const entriesContainer = document.getElementById("entries");
const emptyState = document.getElementById("empty-state");
const saveButton = document.getElementById("save-button");
const saveIndicator = document.getElementById("save-indicator");
const clearButton = document.getElementById("clear-button");
const reminderToggle = document.getElementById("reminder-toggle");
const stopAlertButton = document.getElementById("stop-alert-button");
const reminderStatus = document.getElementById("reminder-status");
const nextReminder = document.getElementById("next-reminder");
const usernameInput = document.getElementById("username-input");
const passwordInput = document.getElementById("password-input");
const loadUserButton = document.getElementById("load-user-button");
const activeUserLabel = document.getElementById("active-user-label");
const tabButtons = document.querySelectorAll(".tab");
const addPanel = document.getElementById("panel-add");
const timetablePanel = document.getElementById("panel-timetable");

const CURRENT_SESSION_KEY = "timetableCurrentSession";
const DEFAULT_USERNAME = "guest";
const DEFAULT_PASSWORD = "guest";
const USER_ENTRIES_SUFFIX = "entries";
const USER_REMINDER_ENABLED_SUFFIX = "remindersEnabled";
const USER_REMINDER_FIRED_SUFFIX = "reminderFiredEvents";
const REMINDER_GRACE_MINUTES = 2;
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];
const DAY_NAME_TO_INDEX = Object.fromEntries(
  DAY_NAMES.map((day, index) => [day, index])
);

let entries = [];
let isSaved = true;
let remindersEnabled = false;
let activeUsername = DEFAULT_USERNAME;
let activePasswordHash = "";
let reminderIntervalId = null;
let activeAlertIntervalId = null;
let firedReminderEvents = new Set();
let audioContext = null;

const normalizeUsername = (value) => {
  const cleaned =
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return cleaned || DEFAULT_USERNAME;
};

const normalizePassword = (value) =>
  typeof value === "string" ? value.trim() : "";

const hashCredential = (username, password) => {
  const source = `${normalizeUsername(username).toLowerCase()}::${password}`;
  let hash = 2166136261;

  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return (hash >>> 0).toString(36);
};

const makeDefaultPasswordHash = () =>
  hashCredential(DEFAULT_USERNAME, DEFAULT_PASSWORD);

const getUserStorageKey = (username, passwordHash, suffix) => {
  const userKey = encodeURIComponent(normalizeUsername(username).toLowerCase());
  return `timetable:${userKey}:${passwordHash}:${suffix}`;
};

const getCurrentUserStorageKey = (suffix) =>
  getUserStorageKey(activeUsername, activePasswordHash, suffix);

const persistCurrentSession = () => {
  localStorage.setItem(
    CURRENT_SESSION_KEY,
    JSON.stringify({
      username: activeUsername,
      passwordHash: activePasswordHash
    })
  );
};

const loadCurrentSession = () => {
  const fallback = {
    username: DEFAULT_USERNAME,
    passwordHash: makeDefaultPasswordHash()
  };

  try {
    const raw = localStorage.getItem(CURRENT_SESSION_KEY);
    if (!raw) {
      activeUsername = fallback.username;
      activePasswordHash = fallback.passwordHash;
      persistCurrentSession();
      return;
    }

    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.username !== "string" ||
      typeof parsed.passwordHash !== "string" ||
      !parsed.passwordHash
    ) {
      activeUsername = fallback.username;
      activePasswordHash = fallback.passwordHash;
      persistCurrentSession();
      return;
    }

    activeUsername = normalizeUsername(parsed.username);
    activePasswordHash = parsed.passwordHash;
  } catch (_error) {
    activeUsername = fallback.username;
    activePasswordHash = fallback.passwordHash;
    persistCurrentSession();
  }
};

const updateSaveIndicator = (status) => {
  saveIndicator.textContent = status;
};

const updateReminderStatus = (status) => {
  reminderStatus.textContent = status;
};

const updateActiveUserLabel = () => {
  activeUserLabel.textContent = `User: ${activeUsername}`;
};

const updateReminderToggleLabel = () => {
  reminderToggle.textContent = remindersEnabled
    ? "Disable reminders"
    : "Enable reminders";
};

const setActiveTab = (tabName) => {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  addPanel.hidden = tabName !== "add";
  timetablePanel.hidden = tabName !== "timetable";
};

const toLocalDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const timeToMinutes = (timeString) => {
  if (typeof timeString !== "string") {
    return null;
  }

  const [hours, minutes] = timeString.split(":").map(Number);
  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return hours * 60 + minutes;
};

const generateId = () => {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `entry-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
};

const findNextReminderEvent = () => {
  if (entries.length === 0) {
    return null;
  }

  const now = new Date();
  let nextEvent = null;

  entries.forEach((entry) => {
    const dayIndex = DAY_NAME_TO_INDEX[entry.day];
    if (dayIndex === undefined) {
      return;
    }

    [
      { type: "start", time: entry.start },
      { type: "end", time: entry.end }
    ].forEach((event) => {
      const minutes = timeToMinutes(event.time);
      if (minutes === null) {
        return;
      }

      const candidate = new Date(now);
      const daysUntil = (dayIndex - now.getDay() + 7) % 7;
      candidate.setDate(now.getDate() + daysUntil);
      candidate.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);

      if (candidate <= now) {
        candidate.setDate(candidate.getDate() + 7);
      }

      if (!nextEvent || candidate < nextEvent.when) {
        nextEvent = {
          entry,
          type: event.type,
          when: candidate
        };
      }
    });
  });

  return nextEvent;
};

const updateNextReminderLabel = () => {
  const nextEvent = findNextReminderEvent();

  if (!nextEvent) {
    nextReminder.textContent = "No upcoming reminders";
    return;
  }

  const eventLabel = nextEvent.type === "start" ? "Start" : "End";
  const dayAndTime = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit"
  }).format(nextEvent.when);
  nextReminder.textContent = `Next: ${eventLabel} ${nextEvent.entry.subject} (${dayAndTime})`;
};

const renderEntries = () => {
  entriesContainer.innerHTML = "";

  if (entries.length === 0) {
    emptyState.style.display = "block";
    updateNextReminderLabel();
    return;
  }

  emptyState.style.display = "none";

  entries
    .slice()
    .sort((a, b) => {
      if (a.day === b.day) {
        return a.start.localeCompare(b.start);
      }
      return a.day.localeCompare(b.day);
    })
    .forEach((entry) => {
      const row = document.createElement("div");
      row.className = "table__row";
      row.innerHTML = `
        <span>${entry.day}</span>
        <span>${entry.subject}</span>
        <span class="entry__time">${entry.start} - ${entry.end}</span>
        <span>${entry.notes || "-"}</span>
        <button class="entry__remove" type="button">Remove</button>
      `;

      row.querySelector("button").addEventListener("click", () => {
        entries = entries.filter((item) => item.id !== entry.id);
        isSaved = false;
        updateSaveIndicator("Not saved");
        renderEntries();
      });

      entriesContainer.appendChild(row);
    });

  updateNextReminderLabel();
};

const pruneFiredReminderEvents = () => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 14);
  const cutoffKey = toLocalDateKey(cutoffDate);

  firedReminderEvents = new Set(
    [...firedReminderEvents].filter((key) => key.split(":")[0] >= cutoffKey)
  );
};

const persistFiredReminderEvents = () => {
  pruneFiredReminderEvents();
  localStorage.setItem(
    getCurrentUserStorageKey(USER_REMINDER_FIRED_SUFFIX),
    JSON.stringify([...firedReminderEvents])
  );
};

const loadReminderState = () => {
  remindersEnabled =
    localStorage.getItem(getCurrentUserStorageKey(USER_REMINDER_ENABLED_SUFFIX)) ===
    "true";

  try {
    const raw = localStorage.getItem(
      getCurrentUserStorageKey(USER_REMINDER_FIRED_SUFFIX)
    );
    const parsed = raw ? JSON.parse(raw) : [];
    firedReminderEvents = new Set(
      Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []
    );
  } catch (_error) {
    firedReminderEvents = new Set();
  }

  persistFiredReminderEvents();
  updateReminderToggleLabel();
};

const loadEntries = () => {
  const raw = localStorage.getItem(getCurrentUserStorageKey(USER_ENTRIES_SUFFIX));

  if (!raw) {
    entries = [];
    isSaved = true;
    updateSaveIndicator("All changes saved");
    renderEntries();
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    entries = [];
    localStorage.removeItem(getCurrentUserStorageKey(USER_ENTRIES_SUFFIX));
    updateSaveIndicator("Storage data was reset");
    renderEntries();
    return;
  }

  isSaved = true;
  updateSaveIndicator("All changes saved");
  renderEntries();
};

const saveEntries = () => {
  saveButton.disabled = true;
  updateSaveIndicator("Saving...");

  try {
    localStorage.setItem(
      getCurrentUserStorageKey(USER_ENTRIES_SUFFIX),
      JSON.stringify(entries)
    );
  } catch (_error) {
    updateSaveIndicator("Save failed");
    saveButton.disabled = false;
    return false;
  }

  isSaved = true;
  updateSaveIndicator("All changes saved");
  saveButton.disabled = false;
  return true;
};

const ensureAudioContext = async () => {
  if (!window.AudioContext && !window.webkitAudioContext) {
    return;
  }

  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtor();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
};

const playTone = (startAt, duration, frequency) => {
  if (!audioContext || audioContext.state !== "running") {
    return;
  }

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gainNode.gain.setValueAtTime(0.0001, startAt);
  gainNode.gain.exponentialRampToValueAtTime(0.2, startAt + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
};

const playReminderBeep = (type) => {
  if (!audioContext || audioContext.state !== "running") {
    return;
  }

  const current = audioContext.currentTime;
  if (type === "start") {
    playTone(current, 0.15, 880);
    playTone(current + 0.2, 0.15, 988);
    return;
  }

  playTone(current, 0.18, 554);
  playTone(current + 0.24, 0.18, 440);
};

const stopActiveReminderAlert = (statusMessage) => {
  if (activeAlertIntervalId !== null) {
    clearInterval(activeAlertIntervalId);
    activeAlertIntervalId = null;
  }

  stopAlertButton.disabled = true;
  updateNextReminderLabel();

  if (statusMessage) {
    updateReminderStatus(statusMessage);
    return;
  }

  updateReminderStatus(remindersEnabled ? "Reminders on" : "Reminders off");
};

const startActiveReminderAlert = (entry, type) => {
  const runBeep = () => {
    void ensureAudioContext()
      .then(() => {
        playReminderBeep(type);
      })
      .catch(() => {});
  };

  if (activeAlertIntervalId !== null) {
    clearInterval(activeAlertIntervalId);
    activeAlertIntervalId = null;
  }

  stopAlertButton.disabled = false;
  runBeep();
  activeAlertIntervalId = window.setInterval(runBeep, 2_400);

  const action = type === "start" ? "Start" : "End";
  updateReminderStatus(
    `${action} reminder active: ${entry.subject} (${entry.start} - ${entry.end})`
  );
};

const requestNotificationAccess = async () => {
  if (!("Notification" in window)) {
    return;
  }

  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
};

const showReminderNotification = (entry, type) => {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const label = type === "start" ? "Start now" : "End now";
  new Notification(`Study reminder: ${entry.subject}`, {
    body: `${label} (${entry.day} ${entry.start} - ${entry.end})`
  });
};

const maybeTriggerReminder = (entry, type, eventMinutes, nowMinutes, dateKey) => {
  if (
    eventMinutes === null ||
    nowMinutes < eventMinutes ||
    nowMinutes > eventMinutes + REMINDER_GRACE_MINUTES
  ) {
    return;
  }

  const eventKey = `${dateKey}:${entry.id}:${type}:${eventMinutes}`;
  if (firedReminderEvents.has(eventKey)) {
    return;
  }

  firedReminderEvents.add(eventKey);
  persistFiredReminderEvents();
  startActiveReminderAlert(entry, type);
  showReminderNotification(entry, type);
  updateNextReminderLabel();
};

const checkReminders = () => {
  if (!remindersEnabled || entries.length === 0) {
    return;
  }

  const now = new Date();
  const dateKey = toLocalDateKey(now);
  const dayName = DAY_NAMES[now.getDay()];
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  entries.forEach((entry) => {
    if (entry.day !== dayName) {
      return;
    }

    maybeTriggerReminder(
      entry,
      "start",
      timeToMinutes(entry.start),
      nowMinutes,
      dateKey
    );
    maybeTriggerReminder(entry, "end", timeToMinutes(entry.end), nowMinutes, dateKey);
  });
};

const startReminderLoop = () => {
  if (reminderIntervalId !== null) {
    return;
  }

  checkReminders();
  reminderIntervalId = window.setInterval(checkReminders, 15_000);
};

const stopReminderLoop = () => {
  if (reminderIntervalId === null) {
    return;
  }

  clearInterval(reminderIntervalId);
  reminderIntervalId = null;
};

const setRemindersEnabled = (enabled) => {
  remindersEnabled = enabled;
  localStorage.setItem(
    getCurrentUserStorageKey(USER_REMINDER_ENABLED_SUFFIX),
    String(enabled)
  );
  updateReminderToggleLabel();
  updateNextReminderLabel();

  if (remindersEnabled) {
    if (activeAlertIntervalId === null) {
      updateReminderStatus("Reminders on");
    }
    startReminderLoop();
    return;
  }

  stopReminderLoop();
  stopActiveReminderAlert("Reminders off");
};

const loadUserData = () => {
  stopReminderLoop();
  stopActiveReminderAlert("Reminders off");
  loadReminderState();
  loadEntries();

  if (remindersEnabled) {
    updateReminderStatus("Reminders on");
    startReminderLoop();
  } else {
    updateReminderStatus("Reminders off");
  }
};

const switchUser = () => {
  const newUsername = normalizeUsername(usernameInput.value);
  const newPassword = normalizePassword(passwordInput.value);

  if (!newPassword) {
    updateSaveIndicator("Enter password to load user");
    passwordInput.focus();
    return;
  }

  if (!isSaved) {
    const ok = saveEntries();
    if (!ok) {
      return;
    }
  }

  activeUsername = newUsername;
  activePasswordHash = hashCredential(newUsername, newPassword);
  persistCurrentSession();
  usernameInput.value = activeUsername;
  passwordInput.value = "";
  updateActiveUserLabel();
  loadUserData();
};

entryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(entryForm);

  const entry = {
    id: generateId(),
    day: formData.get("day"),
    subject: formData.get("subject").trim(),
    start: formData.get("start"),
    end: formData.get("end"),
    notes: formData.get("notes").trim()
  };

  entries.push(entry);
  isSaved = false;
  updateSaveIndicator("Not saved");
  renderEntries();
  entryForm.reset();
});

saveButton.addEventListener("click", () => {
  saveEntries();
});

clearButton.addEventListener("click", () => {
  entries = [];
  isSaved = false;
  updateSaveIndicator("Not saved");
  renderEntries();
});

loadUserButton.addEventListener("click", () => {
  switchUser();
});

usernameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    switchUser();
  }
});

passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    switchUser();
  }
});

stopAlertButton.addEventListener("click", () => {
  stopActiveReminderAlert();
});

reminderToggle.addEventListener("click", async () => {
  if (!remindersEnabled) {
    await ensureAudioContext().catch(() => {});
    await requestNotificationAccess().catch(() => {});
    setRemindersEnabled(true);
    return;
  }

  setRemindersEnabled(false);
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tab);
  });
});

window.addEventListener("pointerdown", () => {
  if (remindersEnabled || activeAlertIntervalId !== null) {
    void ensureAudioContext().catch(() => {});
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!isSaved) {
    event.preventDefault();
    event.returnValue = "";
  }
});

loadCurrentSession();
usernameInput.value = activeUsername;
passwordInput.value = "";
updateActiveUserLabel();
setActiveTab("timetable");
loadUserData();
