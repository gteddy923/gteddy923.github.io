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
const signInButton = document.getElementById("sign-in-button");
const signOutButton = document.getElementById("sign-out-button");
const activeUserLabel = document.getElementById("active-user-label");
const authFeedback = document.getElementById("auth-feedback");
const tabButtons = document.querySelectorAll(".tab");
const addPanel = document.getElementById("panel-add");
const timetablePanel = document.getElementById("panel-timetable");

const SUPABASE_URL =
  typeof window.__SUPABASE_URL__ === "string"
    ? window.__SUPABASE_URL__.trim()
    : "";
const SUPABASE_ANON_KEY =
  typeof window.__SUPABASE_ANON_KEY__ === "string"
    ? window.__SUPABASE_ANON_KEY__.trim()
    : "";

const TIMETABLE_NAME = "default";
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
let timetableRowId = null;
let reminderIntervalId = null;
let activeAlertIntervalId = null;
let firedReminderEvents = new Set();
let audioContext = null;
let supabaseClient = null;
let activeUser = null;
let authActionPending = false;

const setText = (element, value) => {
  if (element) {
    element.textContent = value;
  }
};

const setDisabled = (element, value) => {
  if (element) {
    element.disabled = value;
  }
};

const addListener = (element, eventName, handler) => {
  if (element) {
    element.addEventListener(eventName, handler);
  }
};

const normalizeEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const normalizePassword = (value) =>
  typeof value === "string" ? value.trim() : "";

const getErrorMessage = (error, fallback = "Unexpected error") => {
  if (!error) {
    return fallback;
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return fallback;
};

const updateSaveIndicator = (status) => {
  setText(saveIndicator, status);
};

const updateReminderStatus = (status) => {
  setText(reminderStatus, status);
};

const updateAuthFeedback = (status) => {
  setText(authFeedback, status);
};

const updateActiveUserLabel = () => {
  if (!activeUser) {
    setText(activeUserLabel, "User: signed out");
    return;
  }

  setText(activeUserLabel, `User: ${activeUser.email || activeUser.id}`);
};

const updateReminderToggleLabel = () => {
  setText(reminderToggle, remindersEnabled ? "Disable reminders" : "Enable reminders");
};

const updateAuthButtons = () => {
  const authAvailable = Boolean(supabaseClient);
  setDisabled(signInButton, !authAvailable || authActionPending);
  setDisabled(signOutButton, !authAvailable || authActionPending || !activeUser);
};

const setAuthActionPending = (pending) => {
  authActionPending = pending;
  updateAuthButtons();
};

const setActiveTab = (tabName) => {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  if (addPanel) {
    addPanel.hidden = tabName !== "add";
  }

  if (timetablePanel) {
    timetablePanel.hidden = tabName !== "timetable";
  }
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

const normalizeEntry = (entry) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const day = typeof entry.day === "string" ? entry.day.trim() : "";
  const subject =
    typeof entry.subject === "string" ? entry.subject.trim() : "";
  const start = typeof entry.start === "string" ? entry.start.trim() : "";
  const end = typeof entry.end === "string" ? entry.end.trim() : "";
  const notes = typeof entry.notes === "string" ? entry.notes.trim() : "";

  if (
    !DAY_NAME_TO_INDEX.hasOwnProperty(day) ||
    !subject ||
    timeToMinutes(start) === null ||
    timeToMinutes(end) === null
  ) {
    return null;
  }

  return {
    id:
      typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : generateId(),
    day,
    subject,
    start,
    end,
    notes
  };
};

const normalizeEntries = (rawData) => {
  const rawEntries = Array.isArray(rawData)
    ? rawData
    : rawData && Array.isArray(rawData.entries)
      ? rawData.entries
      : [];

  return rawEntries
    .map((entry) => normalizeEntry(entry))
    .filter((entry) => entry !== null);
};

const getReminderStorageKey = (suffix) => {
  if (!activeUser) {
    return null;
  }

  return `timetable:${activeUser.id}:${suffix}`;
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
    setText(nextReminder, "No upcoming reminders");
    return;
  }

  const eventLabel = nextEvent.type === "start" ? "Start" : "End";
  const dayAndTime = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit"
  }).format(nextEvent.when);
  setText(
    nextReminder,
    `Next: ${eventLabel} ${nextEvent.entry.subject} (${dayAndTime})`
  );
};

const renderEntries = () => {
  if (!entriesContainer || !emptyState) {
    return;
  }

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
      const dayDelta = DAY_NAME_TO_INDEX[a.day] - DAY_NAME_TO_INDEX[b.day];
      if (dayDelta !== 0) {
        return dayDelta;
      }
      return a.start.localeCompare(b.start);
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
        if (!activeUser) {
          updateSaveIndicator("Sign in to edit timetable");
          return;
        }

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

  const storageKey = getReminderStorageKey(USER_REMINDER_FIRED_SUFFIX);
  if (!storageKey) {
    return;
  }

  localStorage.setItem(storageKey, JSON.stringify([...firedReminderEvents]));
};

const loadReminderState = () => {
  if (!activeUser) {
    remindersEnabled = false;
    firedReminderEvents = new Set();
    updateReminderToggleLabel();
    return;
  }

  const remindersEnabledKey = getReminderStorageKey(
    USER_REMINDER_ENABLED_SUFFIX
  );
  remindersEnabled = localStorage.getItem(remindersEnabledKey) === "true";

  try {
    const firedEventsKey = getReminderStorageKey(USER_REMINDER_FIRED_SUFFIX);
    const raw = localStorage.getItem(firedEventsKey);
    const parsed = raw ? JSON.parse(raw) : [];
    firedReminderEvents = new Set(
      Array.isArray(parsed)
        ? parsed.filter((item) => typeof item === "string")
        : []
    );
  } catch (_error) {
    firedReminderEvents = new Set();
  }

  persistFiredReminderEvents();
  updateReminderToggleLabel();
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

  setDisabled(stopAlertButton, true);
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

  setDisabled(stopAlertButton, false);
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
  const storageKey = getReminderStorageKey(USER_REMINDER_ENABLED_SUFFIX);
  if (storageKey) {
    localStorage.setItem(storageKey, String(enabled));
  }

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

const loadEntriesFromCloud = async () => {
  if (!activeUser || !supabaseClient) {
    entries = [];
    isSaved = true;
    timetableRowId = null;
    renderEntries();
    return;
  }

  updateSaveIndicator("Loading timetable...");

  try {
    const { data, error } = await supabaseClient
      .from("timetables")
      .select("id, data_json, updated_at")
      .eq("user_id", activeUser.id)
      .eq("name", TIMETABLE_NAME)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (error) {
      entries = [];
      isSaved = true;
      timetableRowId = null;
      updateSaveIndicator("Failed to load timetable");
      renderEntries();
      return;
    }

    if (!data || data.length === 0) {
      entries = [];
      isSaved = true;
      timetableRowId = null;
      updateSaveIndicator("No saved timetable yet");
      renderEntries();
      return;
    }

    timetableRowId = data[0].id;
    entries = normalizeEntries(data[0].data_json);
    isSaved = true;
    updateSaveIndicator("All changes saved");
    renderEntries();
  } catch (_error) {
    entries = [];
    isSaved = true;
    timetableRowId = null;
    updateSaveIndicator("Failed to load timetable");
    renderEntries();
  }
};

const saveEntries = async () => {
  if (!activeUser || !supabaseClient) {
    updateSaveIndicator("Sign in to save timetable");
    return false;
  }

  setDisabled(saveButton, true);
  updateSaveIndicator("Saving...");

  const payload = entries.map((entry) => ({
    id: entry.id,
    day: entry.day,
    subject: entry.subject,
    start: entry.start,
    end: entry.end,
    notes: entry.notes
  }));

  const updatePayload = {
    data_json: payload,
    updated_at: new Date().toISOString()
  };

  try {
    const { data: updatedRows, error: updateError } = await supabaseClient
      .from("timetables")
      .update(updatePayload)
      .eq("user_id", activeUser.id)
      .eq("name", TIMETABLE_NAME)
      .select("id");

    if (updateError) {
      updateSaveIndicator("Save failed");
      return false;
    }

    if (updatedRows && updatedRows.length > 0) {
      timetableRowId = updatedRows[0].id;
      isSaved = true;
      updateSaveIndicator("All changes saved");
      return true;
    }

    const { data: insertedRow, error: insertError } = await supabaseClient
      .from("timetables")
      .insert({
        user_id: activeUser.id,
        name: TIMETABLE_NAME,
        data_json: payload
      })
      .select("id")
      .single();

    if (insertError) {
      updateSaveIndicator("Save failed");
      return false;
    }

    timetableRowId = insertedRow.id;
    isSaved = true;
    updateSaveIndicator("All changes saved");
    return true;
  } catch (_error) {
    updateSaveIndicator("Save failed");
    return false;
  } finally {
    setDisabled(saveButton, false);
  }
};

const applySignedOutState = (statusMessage = "Sign in to load your timetable") => {
  stopReminderLoop();
  stopActiveReminderAlert("Reminders off");
  remindersEnabled = false;
  updateReminderToggleLabel();
  firedReminderEvents = new Set();
  timetableRowId = null;
  activeUser = null;
  entries = [];
  isSaved = true;
  renderEntries();
  updateReminderStatus("Reminders off");
  updateSaveIndicator(statusMessage);
  updateAuthFeedback(statusMessage);
  updateActiveUserLabel();
  updateAuthButtons();
};

const loadUserData = async () => {
  stopReminderLoop();
  stopActiveReminderAlert("Reminders off");
  loadReminderState();
  await loadEntriesFromCloud();

  if (remindersEnabled) {
    updateReminderStatus("Reminders on");
    startReminderLoop();
  } else {
    updateReminderStatus("Reminders off");
  }
};

const refreshSessionState = async (signedOutMessage) => {
  if (!supabaseClient) {
    applySignedOutState("Set Supabase URL and anon key in index.html");
    return;
  }

  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) {
      applySignedOutState("Authentication error");
      return;
    }

    const sessionUser = data.session?.user ?? null;
    if (!sessionUser) {
      applySignedOutState(signedOutMessage || "Sign in to load your timetable");
      return;
    }

    activeUser = sessionUser;
    timetableRowId = null;
    usernameInput.value = sessionUser.email || "";
    passwordInput.value = "";
    updateActiveUserLabel();
    updateAuthButtons();
    updateAuthFeedback("Signed in");
    await loadUserData();
  } catch (_error) {
    applySignedOutState("Authentication error");
  }
};

const readCredentials = () => {
  const email = normalizeEmail(usernameInput.value);
  const password = normalizePassword(passwordInput.value);
  return { email, password };
};

const signIn = async () => {
  if (!supabaseClient) {
    updateSaveIndicator("Set Supabase URL and anon key in index.html");
    updateAuthFeedback("Set Supabase URL and anon key in index.html");
    return;
  }

  const { email, password } = readCredentials();
  if (!email || !password) {
    updateSaveIndicator("Enter email and password");
    updateAuthFeedback("Enter email and password");
    return;
  }

  if (activeUser && !isSaved) {
    const saved = await saveEntries();
    if (!saved) {
      return;
    }
  }

  setAuthActionPending(true);
  updateAuthFeedback("Signing in...");
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      const errorMessage = getErrorMessage(error, "Sign in failed");
      updateSaveIndicator(`Sign in failed: ${errorMessage}`);
      updateAuthFeedback(`Sign in failed: ${errorMessage}`);
      return;
    }

    await refreshSessionState();
    updateSaveIndicator("Signed in");
    updateAuthFeedback("Signed in");
  } catch (error) {
    const errorMessage = getErrorMessage(error, "Sign in failed");
    updateSaveIndicator(`Sign in failed: ${errorMessage}`);
    updateAuthFeedback(`Sign in failed: ${errorMessage}`);
  } finally {
    setAuthActionPending(false);
  }
};

const signOut = async () => {
  if (!activeUser || !supabaseClient) {
    return;
  }

  if (!isSaved) {
    const saved = await saveEntries();
    if (!saved) {
      return;
    }
  }

  setAuthActionPending(true);
  updateAuthFeedback("Signing out...");
  try {
    const { error } = await supabaseClient.auth.signOut();

    if (error) {
      const errorMessage = getErrorMessage(error, "Sign out failed");
      updateSaveIndicator(`Sign out failed: ${errorMessage}`);
      updateAuthFeedback(`Sign out failed: ${errorMessage}`);
      return;
    }

    await refreshSessionState("Signed out");
    updateAuthFeedback("Signed out");
  } catch (error) {
    const errorMessage = getErrorMessage(error, "Sign out failed");
    updateSaveIndicator(`Sign out failed: ${errorMessage}`);
    updateAuthFeedback(`Sign out failed: ${errorMessage}`);
  } finally {
    setAuthActionPending(false);
  }
};

addListener(entryForm, "submit", (event) => {
  event.preventDefault();

  if (!activeUser) {
    updateSaveIndicator("Sign in to edit timetable");
    return;
  }

  const formData = new FormData(entryForm);
  const subject = (formData.get("subject") || "").toString().trim();
  const notes = (formData.get("notes") || "").toString().trim();

  const entry = {
    id: generateId(),
    day: (formData.get("day") || "").toString(),
    subject,
    start: (formData.get("start") || "").toString(),
    end: (formData.get("end") || "").toString(),
    notes
  };

  const normalized = normalizeEntry(entry);
  if (!normalized) {
    updateSaveIndicator("Invalid study session details");
    return;
  }

  entries.push(normalized);
  isSaved = false;
  updateSaveIndicator("Not saved");
  renderEntries();
  entryForm.reset();
});

addListener(saveButton, "click", () => {
  void saveEntries();
});

addListener(clearButton, "click", () => {
  if (!activeUser) {
    updateSaveIndicator("Sign in to edit timetable");
    return;
  }

  entries = [];
  isSaved = false;
  updateSaveIndicator("Not saved");
  renderEntries();
});

addListener(signInButton, "click", () => {
  void signIn();
});

addListener(signOutButton, "click", () => {
  void signOut();
});

addListener(usernameInput, "keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void signIn();
  }
});

addListener(passwordInput, "keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void signIn();
  }
});

addListener(stopAlertButton, "click", () => {
  stopActiveReminderAlert();
});

addListener(reminderToggle, "click", async () => {
  if (!activeUser) {
    updateSaveIndicator("Sign in to use reminders");
    return;
  }

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

const initializeApp = async () => {
  setActiveTab("timetable");
  updateReminderToggleLabel();
  updateActiveUserLabel();
  updateAuthFeedback("Enter email and password to sign in");
  updateAuthButtons();

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !window.supabase ||
    typeof window.supabase.createClient !== "function"
  ) {
    applySignedOutState("Set Supabase URL and anon key in index.html");
    return;
  }

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  updateAuthButtons();
  await refreshSessionState();
};

void initializeApp();
