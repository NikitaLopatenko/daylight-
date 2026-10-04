import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  processAssistantMessage,
  WEEKDAYS,
  type ChatMessage,
  type ScheduleEvent,
  type Weekday,
} from "./assistant";
import {
  buildSuggestedPlan,
  minutesToTime,
  parseAddressInput,
  type PlaceSettings,
  type PlaceRole,
  type SavedPlace,
  type SuggestedPlan,
} from "./planner";
import {
  buildHeatmap,
  describeSleep,
  emptyDay,
  formatDayKey,
  habitLevel,
  plannerDate,
  plannerDayKey,
  readJournal,
  readLastPlannerDay,
  sleepDurationHours,
  sleepLevel,
  updateDay,
  writeJournal,
  writeLastPlannerDay,
  type Journal,
} from "./journal";
import { SleepTimeline } from "./SleepTimeline";
import {
  addGoal,
  ensureUser,
  isFirebaseConfigured,
  loadGoals,
  loadProfile,
  recordHabitDate,
  removeGoal,
  saveChatDay,
  saveMemorySummary,
  setGoalStatus,
  type Goal,
  type StoredChatMessage,
} from "./lib/firebase";
import { askPlanner, isGeminiConfigured } from "./lib/gemini";
import { startVoiceInput, type VoiceSession } from "./speech";
import "./App.css";

type Task = {
  id: number;
  title: string;
  context: "Home" | "Campus" | "Anywhere";
  points: number;
  done: boolean;
  address?: string;
  placeId?: number;
};

type Habit = {
  id: number;
  title: string;
  icon: string;
  done: boolean;
};

type Birthday = {
  id: number;
  name: string;
  date: string;
};

const initialTasks: Task[] = [
  { id: 1, title: "Review calculus notes", context: "Campus", points: 15, done: true },
  { id: 2, title: "Email Professor Miller", context: "Anywhere", points: 10, done: false },
  { id: 3, title: "Work on portfolio project", context: "Home", points: 25, done: false },
  { id: 4, title: "Pick up groceries", context: "Campus", points: 10, done: false },
];

const initialHabits: Habit[] = [
  { id: 1, title: "Read nonfiction", icon: "⌁", done: true },
  { id: 2, title: "Work out", icon: "◇", done: false },
  { id: 3, title: "Project focus", icon: "↗", done: false },
  { id: 4, title: "Bed before 11", icon: "☾", done: false },
];

const initialSchedule: ScheduleEvent[] = [
  {
    id: 101,
    days: ["Monday", "Wednesday"],
    time: "13:45",
    endTime: "15:15",
    title: "Machine Learning",
    location: "LLAB 10 · UPenn",
  },
  {
    id: 102,
    days: ["Tuesday", "Thursday"],
    time: "10:15",
    endTime: "11:44",
    title: "Numerical and Applied Analysis I",
    location: "LERN 102",
  },
  {
    id: 103,
    days: ["Monday"],
    time: "17:15",
    endTime: "20:14",
    title: "GPU Programming and Architecture",
    location: "SKIR AUD",
  },
  {
    id: 104,
    days: ["Wednesday"],
    time: "17:15",
    endTime: "18:44",
    title: "GPU Programming and Architecture",
    location: "SKIR AUD",
  },
];

const initialBirthdays: Birthday[] = [
  { id: 1, name: "Alex", date: "2026-09-12" },
];

const initialPlaces: PlaceSettings = {
  city: "Philadelphia, PA",
  places: [],
};

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readPlaceSettings(): PlaceSettings {
  const stored = readStored<PlaceSettings & {
    home?: string;
    gym?: string;
    dining?: string;
  }>("daylight-places", initialPlaces);
  if (Array.isArray(stored.places)) return stored;

  const legacyPlaces: SavedPlace[] = [
    stored.home ? { id: 1, name: "Home", address: stored.home, role: "Home" } : null,
    stored.gym ? { id: 2, name: "Gym", address: stored.gym, role: "Gym" } : null,
    stored.dining ? { id: 3, name: "Dining hall", address: stored.dining, role: "Dining" } : null,
  ].filter((place): place is SavedPlace => place !== null);
  return { city: stored.city || "Philadelphia, PA", places: legacyPlaces };
}

function App() {
  const [tasks, setTasks] = useState<Task[]>(() => readStored("daylight-tasks", initialTasks));
  const [habits, setHabits] = useState<Habit[]>(() => readStored("daylight-habits", initialHabits));
  const [schedule, setSchedule] = useState<ScheduleEvent[]>(() => readStored("daylight-schedule-v2", initialSchedule));
  const [birthdays, setBirthdays] = useState<Birthday[]>(() => readStored("daylight-birthdays", initialBirthdays));
  const [places, setPlaces] = useState<PlaceSettings>(readPlaceSettings);
  const [suggestedPlan, setSuggestedPlan] = useState<SuggestedPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [newTask, setNewTask] = useState("");
  const [newHabit, setNewHabit] = useState("");
  const [newBirthday, setNewBirthday] = useState("");
  const [birthdayDate, setBirthdayDate] = useState("");
  const [newPlaceName, setNewPlaceName] = useState("");
  const [newPlaceAddress, setNewPlaceAddress] = useState("");
  const [newPlaceRole, setNewPlaceRole] = useState<PlaceRole>("Other");
  const [editingLocation, setEditingLocation] = useState<{ kind: "task" | "event"; id: number } | null>(null);
  const [locationPlaceId, setLocationPlaceId] = useState("");
  const [customAddress, setCustomAddress] = useState("");
  const [activeView, setActiveView] = useState("Today");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [suggestionVisible, setSuggestionVisible] = useState(true);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState("");
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(true);
  const [journal, setJournal] = useState<Journal>(() => readJournal());
  const [sleepOpen, setSleepOpen] = useState(false);
  const [sleepStart, setSleepStart] = useState("23:30");
  const [sleepEnd, setSleepEnd] = useState("07:30");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState(isFirebaseConfigured() ? "Connecting…" : "Local only");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [memorySummary, setMemorySummary] = useState("");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalDeadline, setGoalDeadline] = useState("");
  const [goalSteps, setGoalSteps] = useState("");
  const voiceSession = useRef<VoiceSession | null>(null);
  const habitsRef = useRef(habits);
  const voiceInputPrefix = useRef("");
  const [assistantInput, setAssistantInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Ready. Tell me your classes, tasks, or habits in plain English.",
    },
  ]);

  useEffect(() => {
    isEnabled()
      .then(async (enabled) => {
        setLaunchAtLogin(enabled);
        // Enable startup the first time the installed app is opened.
        if (!enabled && !import.meta.env.DEV) {
          await enable();
          setLaunchAtLogin(true);
        }
      })
      .catch(() => {
        // Browser / web preview has no Windows startup APIs.
      });
  }, []);

  useEffect(() => {
    if (schedule.length > 0 && schedule.every((event) => !Array.isArray(event.days))) {
      persistSchedule(initialSchedule);
    }
  }, []);

  useEffect(() => {
    return () => voiceSession.current?.stop();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured()) return;
    ensureUser()
      .then(async (user) => {
        if (!user) {
          setCloudStatus("Firebase config found, but sign-in failed.");
          return;
        }
        setCloudUserId(user.uid);
        const [profile, storedGoals] = await Promise.all([
          loadProfile(user.uid),
          loadGoals(user.uid),
        ]);
        setMemorySummary(profile.memorySummary);
        setGoals(storedGoals);
        setCloudStatus("Cloud planner connected");
      })
      .catch(() => setCloudStatus("Could not reach Firebase. Check Anonymous sign-in and your keys."));
  }, []);

  const today = now;
  const planner = plannerDate(now);
  const dayKey = plannerDayKey(now);
  habitsRef.current = habits;
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(planner);
  const greeting = today.getHours() < 12 ? "Good morning" : today.getHours() < 18 ? "Good afternoon" : "Good evening";

  const completedPoints = tasks.filter((task) => task.done).reduce((total, task) => total + task.points, 0)
    + habits.filter((habit) => habit.done).length * 5;
  const availablePoints = tasks.reduce((total, task) => total + task.points, 0) + habits.length * 5;
  const progress = availablePoints ? Math.round((completedPoints / availablePoints) * 100) : 0;
  const completedCount = tasks.filter((task) => task.done).length;
  const currentDay = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(planner) as Weekday;
  const validSchedule = schedule.filter((event) => Array.isArray(event.days));
  const locationEditingItem = editingLocation
    ? editingLocation.kind === "task"
      ? tasks.find((task) => task.id === editingLocation.id)
      : validSchedule.find((event) => event.id === editingLocation.id)
    : undefined;
  const todaysSchedule = validSchedule
    .filter((event) => event.days.includes(currentDay))
    .sort((first, second) => first.time.localeCompare(second.time));

  const week = useMemo(() => {
    return Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(planner);
      date.setDate(planner.getDate() + offset - 2);
      const key = plannerDayKey(date);
      return {
        day: new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date).slice(0, 2),
        date: date.getDate(),
        current: key === dayKey,
      };
    });
  }, [planner, dayKey]);

  function persistTasks(next: Task[]) {
    setTasks(next);
    localStorage.setItem("daylight-tasks", JSON.stringify(next));
  }

  function persistHabits(next: Habit[]) {
    setHabits(next);
    localStorage.setItem("daylight-habits", JSON.stringify(next));
  }

  function persistSchedule(next: ScheduleEvent[]) {
    const sorted = [...next].sort((first, second) => first.time.localeCompare(second.time));
    setSchedule(sorted);
    localStorage.setItem("daylight-schedule-v2", JSON.stringify(sorted));
  }

  function persistBirthdays(next: Birthday[]) {
    setBirthdays(next);
    localStorage.setItem("daylight-birthdays", JSON.stringify(next));
  }

  function persistPlaces(next: PlaceSettings) {
    setPlaces(next);
    localStorage.setItem("daylight-places", JSON.stringify(next));
  }

  useEffect(() => {
    const last = readLastPlannerDay();
    const currentHabits = habitsRef.current;
    if (last && last !== dayKey) {
      const completed = currentHabits.filter((habit) => habit.done).map((habit) => habit.title);
      const next = readJournal();
      next[last] = { ...emptyDay(), ...next[last], habits: completed };
      writeJournal(next);
      setJournal(next);
      persistHabits(currentHabits.map((habit) => ({ ...habit, done: false })));
    }
    writeLastPlannerDay(dayKey);
    if (!readJournal()[dayKey]?.sleepAsked) setSleepOpen(true);
  }, [dayKey]);

  function addPlace(event: FormEvent) {
    event.preventDefault();
    const name = newPlaceName.trim();
    const address = newPlaceAddress.trim();
    if (!name || !address) return;
    persistPlaces({
      ...places,
      places: [...places.places, { id: Date.now(), name, address, role: newPlaceRole }],
    });
    setNewPlaceName("");
    setNewPlaceAddress("");
    setNewPlaceRole("Other");
  }

  function openLocationEditor(kind: "task" | "event", id: number) {
    const item = kind === "task"
      ? tasks.find((task) => task.id === id)
      : validSchedule.find((event) => event.id === id);
    if (!item) return;
    setEditingLocation({ kind, id });
    setLocationPlaceId(item.placeId ? String(item.placeId) : item.address ? "custom" : "anywhere");
    setCustomAddress(item.address ?? "");
  }

  function saveItemLocation(event: FormEvent) {
    event.preventDefault();
    if (!editingLocation) return;
    const placeId = Number(locationPlaceId) || undefined;
    const address = locationPlaceId === "custom" ? customAddress.trim() || undefined : undefined;

    if (editingLocation.kind === "task") {
      persistTasks(tasks.map((task) => task.id === editingLocation.id
        ? {
          ...task,
          placeId,
          address,
          context: locationPlaceId === "anywhere" ? "Anywhere" : task.context,
        }
        : task));
    } else {
      persistSchedule(validSchedule.map((item) => item.id === editingLocation.id
        ? { ...item, placeId, address }
        : item));
    }
    setEditingLocation(null);
  }

  function deleteEditedItem() {
    if (!editingLocation) return;
    if (editingLocation.kind === "task") {
      persistTasks(tasks.filter((task) => task.id !== editingLocation.id));
    } else {
      persistSchedule(validSchedule.filter((item) => item.id !== editingLocation.id));
    }
    setEditingLocation(null);
  }

  function itemLocationLabel(item: { placeId?: number; address?: string }, fallback: string) {
    if (item.address) return item.address;
    if (item.placeId) return places.places.find((place) => place.id === item.placeId)?.name ?? fallback;
    return fallback;
  }

  function addTask(event: FormEvent) {
    event.preventDefault();
    const title = newTask.trim();
    if (!title) return;
    persistTasks([
      ...tasks,
      { id: Date.now(), title, context: "Anywhere", points: 10, done: false },
    ]);
    setNewTask("");
  }

  function toggleTask(id: number) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    const done = !task.done;
    persistTasks(tasks.map((item) => item.id === id ? { ...item, done } : item));
    const log = readJournal()[dayKey] ?? emptyDay();
    const titles = done
      ? [...new Set([...log.tasks, task.title])]
      : log.tasks.filter((title) => title !== task.title);
    setJournal(updateDay(dayKey, { tasks: titles }));
  }

  function toggleHabit(id: number) {
    const next = habits.map((habit) => habit.id === id ? { ...habit, done: !habit.done } : habit);
    persistHabits(next);
    setJournal(updateDay(dayKey, {
      habits: next.filter((habit) => habit.done).map((habit) => habit.title),
    }));
    const habit = next.find((item) => item.id === id);
    if (cloudUserId && habit) {
      void recordHabitDate(cloudUserId, habit.title, dayKey, habit.done);
    }
  }

  function saveSleep(event: FormEvent) {
    event.preventDefault();
    if (!sleepStart || !sleepEnd) return;
    const hours = sleepDurationHours(sleepStart, sleepEnd);
    if (hours <= 0 || hours > 24) return;
    setJournal(updateDay(dayKey, {
      sleepStart,
      sleepEnd,
      sleepHours: hours,
      sleepAsked: true,
    }));
    setSleepOpen(false);
  }

  function skipSleep() {
    setJournal(updateDay(dayKey, { sleepAsked: true }));
    setSleepOpen(false);
  }

  function addHabit(event: FormEvent) {
    event.preventDefault();
    const title = newHabit.trim();
    if (!title) return;
    persistHabits([...habits, { id: Date.now(), title, icon: "○", done: false }]);
    setNewHabit("");
  }

  function addBirthday(event: FormEvent) {
    event.preventDefault();
    const name = newBirthday.trim();
    if (!name || !birthdayDate) return;
    persistBirthdays([...birthdays, { id: Date.now(), name, date: birthdayDate }]);
    setNewBirthday("");
    setBirthdayDate("");
  }

  async function toggleAlwaysOnTop() {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
    } catch {
      // Native window APIs are unavailable in a browser preview.
    }
  }

  async function toggleLaunchAtLogin() {
    const next = !launchAtLogin;
    setLaunchAtLogin(next);
    try {
      if (next) await enable();
      else await disable();
    } catch {
      // Native autostart APIs are unavailable in a browser preview.
    }
  }

  async function askAssistant(event: FormEvent) {
    event.preventDefault();
    const text = assistantInput.trim();
    if (!text) return;
    if (voiceListening) {
      voiceSession.current?.stop();
      voiceSession.current = null;
      setVoiceListening(false);
    }

    const result = processAssistantMessage(text);
    const now = Date.now();

    if (result.events.length) {
      persistSchedule([
        ...validSchedule,
        ...result.events.map((item, index) => ({ ...item, id: now + index })),
      ]);
    }

    if (result.tasks.length) {
      const existingTitles = new Set(tasks.map((task) => task.title.toLowerCase()));
      persistTasks([
        ...tasks,
        ...result.tasks
          .filter((item) => !existingTitles.has(item.title.toLowerCase()))
          .map((item, index) => ({
            ...item,
            id: now + 100 + index,
            done: false,
          })),
      ]);
    }

    if (result.habits.length) {
      const existingTitles = new Set(habits.map((habit) => habit.title.toLowerCase()));
      persistHabits([
        ...habits,
        ...result.habits
          .filter((item) => !existingTitles.has(item.title.toLowerCase()))
          .map((item, index) => ({
            ...item,
            id: now + 200 + index,
            done: false,
          })),
      ]);
    }

    let reply = result.reply;
    if (isGeminiConfigured()) {
      try {
        const history: StoredChatMessage[] = messages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          content: message.text,
        }));
        reply = await askPlanner({
          userId: cloudUserId,
          today: dayKey,
          message: text,
          history,
        });
      } catch (error) {
        reply = `${result.reply} Cloud planner could not answer: ${error instanceof Error ? error.message : "unknown error"}.`;
      }
    }

    const nextMessages = [
      ...messages,
      { role: "user" as const, text },
      { role: "assistant" as const, text: reply },
    ];
    setMessages(nextMessages);
    setAssistantInput("");
    if (cloudUserId) {
      void saveChatDay(cloudUserId, dayKey, nextMessages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        content: message.text,
      })));
    }
  }

  async function createGoal(event: FormEvent) {
    event.preventDefault();
    if (!cloudUserId || !goalTitle.trim()) return;
    await addGoal(cloudUserId, {
      title: goalTitle.trim(),
      status: "active",
      deadline: goalDeadline,
      subSteps: goalSteps.split(",").map((step) => step.trim()).filter(Boolean),
    });
    setGoals(await loadGoals(cloudUserId));
    setGoalTitle("");
    setGoalDeadline("");
    setGoalSteps("");
  }

  async function saveMemory(event: FormEvent) {
    event.preventDefault();
    if (!cloudUserId) return;
    await saveMemorySummary(cloudUserId, memorySummary);
  }

  function toggleVoiceInput() {
    if (voiceListening) {
      voiceSession.current?.stop();
      voiceSession.current = null;
      setVoiceListening(false);
      return;
    }

    setVoiceMessage("");
    voiceInputPrefix.current = assistantInput.trim();
    const session = startVoiceInput({
      onTranscript: (transcript) => {
        const prefix = voiceInputPrefix.current;
        setAssistantInput(`${prefix}${prefix && transcript ? " " : ""}${transcript}`);
      },
      onEnd: () => {
        voiceSession.current = null;
        setVoiceListening(false);
      },
      onError: (message) => setVoiceMessage(message),
    });

    if (!session) {
      setVoiceMessage("Direct microphone recognition isn’t available here. Click the text box and press Win+H for Windows voice typing.");
      return;
    }

    voiceSession.current = session;
    setVoiceListening(true);
  }

  function closeAssistant() {
    voiceSession.current?.stop();
    voiceSession.current = null;
    setVoiceListening(false);
    setAssistantOpen(false);
  }

  async function generatePlan() {
    setActiveView("Plan");
    setPlanLoading(true);
    setPlanError("");
    try {
      const plan = await buildSuggestedPlan(tasks, validSchedule, currentDay, places, new Date());
      setSuggestedPlan(plan);
    } catch {
      setPlanError("Daylight couldn’t generate the plan. Check your connection and try again.");
    } finally {
      setPlanLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">D</span>
          <span>Daylight</span>
        </div>

        <nav aria-label="Main navigation">
          {[
            ["Today", "⌂"],
            ["Plan", "☷"],
            ["Assistant", "✦"],
            ["Calendar", "□"],
            ["Habits", "○"],
            ["Goals", "▣"],
            ["History", "▦"],
            ["Birthdays", "☆"],
          ].map(([label, icon]) => (
            <button
              className={`nav-item ${activeView === label ? "active" : ""}`}
              key={label}
              onClick={() => {
                if (label === "Assistant") {
                  setAssistantOpen(true);
                  return;
                }
                setActiveView(label);
              }}
            >
              <span>{icon}</span>{label}
              {label === "Birthdays" && <span className="nav-dot" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <button
          className={`nav-item ${activeView === "Settings" ? "active" : ""}`}
          onClick={() => setActiveView("Settings")}
        ><span>⚙</span>Settings</button>
        <div className="profile">
          <div className="avatar">Y</div>
          <div><strong>Your day</strong><small>Synced locally</small></div>
          <span className="online-dot" />
        </div>
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div>
            <p className="eyebrow">{dateLabel}</p>
            <h1>{activeView === "Today" ? greeting : activeView}<span>.</span></h1>
          </div>
          <div className="topbar-actions">
            <button className="assistant-trigger" onClick={() => setAssistantOpen(true)}>
              <span>✦</span> Ask Daylight
            </button>
            <button
              className="icon-button"
              title="Notifications"
              aria-label="Notifications"
              onClick={() => setNotificationsOpen((open) => !open)}
            >♢<i /></button>
            {notificationsOpen && (
              <div className="notification-popover">
                <strong>Notifications</strong>
                <p>☆ Alex’s birthday is coming up.</p>
                <p>✦ You have {todaysSchedule.length} schedule block{todaysSchedule.length === 1 ? "" : "s"} today.</p>
              </div>
            )}
          </div>
        </header>

        {(activeView === "Today" || activeView === "Calendar") && (
        <section className="week-strip" aria-label="Week">
          {week.map((day) => (
            <button
              className={day.current ? "current" : ""}
              key={`${day.day}-${day.date}`}
              onClick={() => setActiveView("Calendar")}
            >
              <span>{day.day}</span><strong>{day.date}</strong>
            </button>
          ))}
        </section>
        )}

        {activeView === "Today" ? (
        <div className="content-grid">
          <section className="primary-column">
            {suggestionVisible && (
            <article className="focus-card">
              <div className="focus-copy">
                <span className="spark">✦</span>
                <div>
                  <small>LOCATION-AWARE PLANNER</small>
                  <h2>Build the best order for today</h2>
                  <p>It is {new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(now)}. Daylight can arrange remaining tasks around lectures, meals, and walking time.</p>
                </div>
              </div>
              <div className="suggestion-actions">
                <button onClick={generatePlan}>Create plan</button>
                <button className="dismiss" onClick={() => setSuggestionVisible(false)} aria-label="Dismiss suggestion">×</button>
              </div>
            </article>
            )}

            <section className="section-block">
              <div className="section-heading">
                <div><h2>Today’s tasks</h2><span>{completedCount} of {tasks.length} complete</span></div>
                <span className="points-pill">✦ {completedPoints} pts</span>
              </div>

              <form className="quick-add" onSubmit={addTask}>
                <span>＋</span>
                <input
                  value={newTask}
                  onChange={(event) => setNewTask(event.target.value)}
                  placeholder="Add a task, reminder, or idea..."
                  aria-label="New task"
                />
                <kbd>Enter</kbd>
              </form>

              <div className="task-list">
                {tasks.map((task) => (
                  <div className={`task-row ${task.done ? "done" : ""}`} key={task.id}>
                    <button className="check" onClick={() => toggleTask(task.id)} aria-label={`Mark ${task.title}`}>
                      {task.done ? "✓" : ""}
                    </button>
                    <div className="task-title">
                      <strong>{task.title}</strong>
                      <small>{itemLocationLabel(task, task.context === "Anywhere" ? "Anywhere" : task.context)}</small>
                    </div>
                    <span className="task-points">+{task.points}</span>
                    <button
                      className="edit-location"
                      onClick={() => openLocationEditor("task", task.id)}
                      aria-label={`Edit ${task.title}`}
                    >•••</button>
                    <button
                      className="remove-task"
                      onClick={() => persistTasks(tasks.filter((item) => item.id !== task.id))}
                      aria-label={`Delete ${task.title}`}
                    >×</button>
                  </div>
                ))}
              </div>
            </section>
          </section>

          <aside className="right-column">
            <article className="score-card">
              <div className="score-top">
                <div><small>DAILY PROGRESS</small><h2>{progress}%</h2></div>
                <div className="score-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}>
                  <span>{completedPoints}</span>
                </div>
              </div>
              <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
              <p>{progress >= 75 ? "Almost there — finish strong." : "Small wins add up. Keep going."}</p>
            </article>

            <article className="schedule-card">
              <div className="card-title"><h2>Up next</h2><button onClick={() => setActiveView("Calendar")} aria-label="Open calendar">•••</button></div>
              <div className="timeline">
                {todaysSchedule.slice(0, 5).map((item, index) => (
                  <div className={`timeline-item ${index === 0 ? "active" : ""}`} key={item.id}>
                    <time>{item.time}</time><span />
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.endTime ? `${item.time}–${item.endTime} · ` : ""}{itemLocationLabel(item, item.location)}</small>
                    </div>
                    <button
                      className="schedule-remove"
                      onClick={() => openLocationEditor("event", item.id)}
                      aria-label={`Edit ${item.title}`}
                    >•••</button>
                  </div>
                ))}
                {!todaysSchedule.length && (
                  <p className="empty-note">Nothing scheduled for {currentDay}. Ask Daylight to add your classes.</p>
                )}
              </div>
              <button className="calendar-link" onClick={() => setActiveView("Calendar")}>View calendar <span>→</span></button>
            </article>

            <article className="habits-card">
              <div className="card-title"><h2>Daily habits</h2><span>{habits.filter((habit) => habit.done).length}/{habits.length}</span></div>
              <div className="habit-grid">
                {habits.map((habit) => (
                  <button className={habit.done ? "done" : ""} key={habit.id} onClick={() => toggleHabit(habit.id)}>
                    <span>{habit.icon}</span><small>{habit.title}</small><i>{habit.done ? "✓" : ""}</i>
                  </button>
                ))}
              </div>
            </article>

            <article className="birthday-card">
              <span className="birthday-icon">♢</span>
              <div><small>UPCOMING</small><strong>{birthdays[0]?.name ?? "Add a birthday"}{birthdays[0] ? "’s birthday" : ""}</strong><p>{birthdays[0]?.date ?? "Never forget an important date."}</p></div>
              <button onClick={() => setActiveView("Birthdays")} aria-label="Birthday details">›</button>
            </article>
          </aside>
        </div>
        ) : activeView === "Calendar" ? (
          <section className="workspace-page">
            <div className="workspace-heading">
              <div>
                <h2>Weekly schedule</h2>
                <p>Your recurring classes and plans, organized by weekday.</p>
              </div>
              <div className="workspace-actions">
                {validSchedule.length > 0 && <button className="secondary-action" onClick={() => persistSchedule([])}>Clear schedule</button>}
                <button className="primary-action" onClick={() => setAssistantOpen(true)}>✦ Add with assistant</button>
              </div>
            </div>
            <div className="calendar-board">
              {WEEKDAYS.slice(0, 5).map((day) => {
                const dayEvents = validSchedule
                  .filter((item) => item.days.includes(day))
                  .sort((first, second) => first.time.localeCompare(second.time));
                return (
                  <div className={`calendar-day ${day === currentDay ? "today" : ""}`} key={day}>
                    <header><strong>{day.slice(0, 3)}</strong><span>{dayEvents.length}</span></header>
                    <div>
                      {dayEvents.map((item) => (
                        <article className="calendar-event" key={`${item.id}-${day}`}>
                          <time>{item.time}{item.endTime ? `–${item.endTime}` : ""}</time>
                          <strong>{item.title}</strong>
                          <small>{itemLocationLabel(item, item.location)}</small>
                          <button onClick={() => openLocationEditor("event", item.id)}>•••</button>
                        </article>
                      ))}
                      {!dayEvents.length && <p className="calendar-empty">No events</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : activeView === "Plan" ? (
          <section className="workspace-page plan-page">
            <div className="workspace-heading">
              <div>
                <h2>Suggested plan</h2>
                <p>Built from the current time, unfinished tasks, fixed lectures, meals, and location distance.</p>
              </div>
              <button className="primary-action" onClick={generatePlan} disabled={planLoading}>
                {planLoading ? "Planning…" : suggestedPlan ? "Regenerate" : "Generate today’s plan"}
              </button>
            </div>

            {!places.places.length && (
              <button className="places-warning" onClick={() => setActiveView("Settings")}>
                <span>⌖</span>
                <div>
                  <strong>Add your usual places for better routing</strong>
                  <small>Save any frequently used location, then attach it to tasks or schedule events.</small>
                </div>
                <b>→</b>
              </button>
            )}

            {planError && <p className="plan-error">{planError}</p>}
            {!suggestedPlan && !planLoading && (
              <div className="plan-empty">
                <span>✦</span>
                <h3>Ready when you are</h3>
                <p>Daylight will only plan unfinished work from the current time forward—it will not send you to a lecture that already ended.</p>
                <button className="primary-action" onClick={generatePlan}>Generate suggested plan</button>
              </div>
            )}
            {planLoading && (
              <div className="plan-empty">
                <span className="planning-spinner">✦</span>
                <h3>Checking time and locations…</h3>
                <p>Matching addresses and arranging tasks around today’s fixed schedule.</p>
              </div>
            )}
            {suggestedPlan && !planLoading && (
              <>
                <div className="plan-status">
                  <span>Generated at {suggestedPlan.generatedAt}</span>
                  <p>⌖ {suggestedPlan.locationStatus}</p>
                </div>
                <div className="suggested-timeline">
                  {suggestedPlan.items.map((item) => (
                    <article className={`plan-item ${item.kind}`} key={item.id}>
                      <div className="plan-time">
                        <strong>{minutesToTime(item.start)}</strong>
                        <small>{minutesToTime(item.end)}</small>
                      </div>
                      <span className="plan-marker">
                        {item.kind === "event" ? "□" : item.kind === "travel" ? "→" : item.kind === "meal" ? "◇" : "✓"}
                      </span>
                      <div className="plan-copy">
                        <strong>{item.title}</strong>
                        {item.location && <small>{item.location}</small>}
                        <p>{item.reason}</p>
                      </div>
                    </article>
                  ))}
                  {!suggestedPlan.items.length && (
                    <div className="plan-empty compact">
                      <h3>Your remaining day is clear</h3>
                      <p>Add unfinished tasks or schedule blocks, then regenerate.</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        ) : activeView === "Goals" ? (
          <section className="workspace-page">
            <div className="workspace-heading">
              <div>
                <h2>Long-term goals</h2>
                <p>{cloudStatus}. Goals and planner memory stay in Firebase and are sent to Gemini with each chat.</p>
              </div>
            </div>
            {!isFirebaseConfigured() ? (
              <div className="plan-empty compact">
                <h3>Cloud planner is not connected</h3>
                <p>Copy `.env.example` to `.env`, add your Firebase web config and Gemini key, then restart Daylight. Enable Anonymous sign-in in Firebase.</p>
              </div>
            ) : (
              <>
                <form className="workspace-form memory-form" onSubmit={saveMemory}>
                  <textarea
                    value={memorySummary}
                    onChange={(event) => setMemorySummary(event.target.value)}
                    placeholder="Long-term memory: semester goals, constraints, people, preferences..."
                  />
                  <button className="primary-action">Save memory</button>
                </form>
                <form className="workspace-form goal-form" onSubmit={createGoal}>
                  <input value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} placeholder="Goal, e.g. Finish internship applications" />
                  <input type="date" value={goalDeadline} onChange={(event) => setGoalDeadline(event.target.value)} />
                  <input value={goalSteps} onChange={(event) => setGoalSteps(event.target.value)} placeholder="Sub-steps, separated by commas" />
                  <button className="primary-action">Add goal</button>
                </form>
                <div className="goal-list">
                  {goals.map((goal) => (
                    <article key={goal.id}>
                      <div>
                        <strong>{goal.title}</strong>
                        <small>{goal.status}{goal.deadline ? ` · due ${goal.deadline}` : ""}</small>
                        {goal.subSteps.length > 0 && <p>{goal.subSteps.join(" · ")}</p>}
                      </div>
                      <div className="goal-actions">
                        {goal.status !== "done" && (
                          <button onClick={async () => {
                            if (!cloudUserId) return;
                            await setGoalStatus(cloudUserId, goal.id, "done");
                            setGoals(await loadGoals(cloudUserId));
                          }}>Done</button>
                        )}
                        <button onClick={async () => {
                          if (!cloudUserId) return;
                          await removeGoal(cloudUserId, goal.id);
                          setGoals(await loadGoals(cloudUserId));
                        }}>Delete</button>
                      </div>
                    </article>
                  ))}
                  {!goals.length && <p className="empty-note">No long-term goals saved yet.</p>}
                </div>
              </>
            )}
          </section>
        ) : activeView === "Habits" ? (
          <section className="workspace-page">
            <div className="workspace-heading">
              <div><h2>Daily habits</h2><p>Build consistency one checkmark at a time.</p></div>
            </div>
            <form className="workspace-form" onSubmit={addHabit}>
              <input value={newHabit} onChange={(event) => setNewHabit(event.target.value)} placeholder="New habit, e.g. Read for 20 minutes" />
              <button className="primary-action">Add habit</button>
            </form>
            <div className="habit-list-page">
              {habits.map((habit) => (
                <article className={habit.done ? "done" : ""} key={habit.id}>
                  <button className="large-habit-check" onClick={() => toggleHabit(habit.id)}>{habit.done ? "✓" : habit.icon}</button>
                  <div><strong>{habit.title}</strong><small>{habit.done ? "Completed today · +5 points" : "Not completed yet"}</small></div>
                  <button className="delete-action" onClick={() => persistHabits(habits.filter((item) => item.id !== habit.id))}>Delete</button>
                </article>
              ))}
            </div>
          </section>
        ) : activeView === "History" ? (
          <section className="workspace-page history-page">
            <div className="workspace-heading">
              <div>
                <h2>Day history</h2>
                <p>Saved on this computer. The day changes at 8:00 AM, so late nights still belong to the previous day.</p>
              </div>
            </div>
            {[
              ["habits", "Habits completed", "Each square is one day. Darker means more habits checked off."],
              ["sleep", "Sleep window", "Each square is hours slept. Click a day to see bedtime and wake time."],
            ].map(([kind, title, caption]) => (
              <section className="heatmap-block" key={kind}>
                <div className="heatmap-heading">
                  <h3>{title}</h3>
                  <p>{caption}</p>
                </div>
                <div className="heatmap" aria-label={title}>
                  <div className="heatmap-days" aria-hidden="true">
                    {["", "Mon", "", "Wed", "", "Fri", ""].map((label, index) => <span key={`${kind}-label-${index}`}>{label}</span>)}
                  </div>
                  <div className="heatmap-grid">
                    {buildHeatmap(journal, kind as "habits" | "sleep", now).map((week, weekIndex) => (
                      <div className="heatmap-week" key={`${kind}-${week[0]?.key ?? weekIndex}`}>
                        {week.map((cell) => (
                          <button
                            className={`heat-cell level-${kind === "habits" ? habitLevel(cell.count) : sleepLevel(cell.count)} ${cell.future ? "future" : ""} ${selectedDay === cell.key ? "selected" : ""}`}
                            key={cell.key}
                            disabled={cell.future}
                            title={cell.future ? "" : `${formatDayKey(cell.key)} · ${kind === "habits" ? `${cell.count} habit${cell.count === 1 ? "" : "s"}` : describeSleep(journal[cell.key])}`}
                            onClick={() => setSelectedDay(cell.key)}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            ))}
            <article className="day-record">
              {selectedDay ? (
                <>
                  <header>
                    <h3>{formatDayKey(selectedDay)}</h3>
                    <span>{describeSleep(journal[selectedDay])}</span>
                  </header>
                  {journal[selectedDay]?.sleepStart && journal[selectedDay]?.sleepEnd && (
                    <SleepTimeline
                      compact
                      start={journal[selectedDay].sleepStart}
                      end={journal[selectedDay].sleepEnd}
                    />
                  )}
                  <div className="day-record-columns">
                    <section>
                      <h4>Habits</h4>
                      {(journal[selectedDay]?.habits ?? []).length ? (
                        <ul>{journal[selectedDay].habits.map((habit) => <li key={habit}>{habit}</li>)}</ul>
                      ) : <p>No habits were checked off.</p>}
                    </section>
                    <section>
                      <h4>Completed that day</h4>
                      {(journal[selectedDay]?.tasks ?? []).length ? (
                        <ul>{journal[selectedDay].tasks.map((task) => <li key={task}>{task}</li>)}</ul>
                      ) : <p>No completed to-dos were saved.</p>}
                    </section>
                  </div>
                </>
              ) : <p>Select a square to open that day.</p>}
            </article>
          </section>
        ) : activeView === "Birthdays" ? (
          <section className="workspace-page">
            <div className="workspace-heading">
              <div><h2>Birthdays</h2><p>Important people and yearly reminders.</p></div>
            </div>
            <form className="workspace-form birthday-form" onSubmit={addBirthday}>
              <input value={newBirthday} onChange={(event) => setNewBirthday(event.target.value)} placeholder="Friend’s name" />
              <input type="date" value={birthdayDate} onChange={(event) => setBirthdayDate(event.target.value)} />
              <button className="primary-action">Add birthday</button>
            </form>
            <div className="birthday-list-page">
              {birthdays.map((birthday) => (
                <article key={birthday.id}>
                  <span>☆</span>
                  <div><strong>{birthday.name}</strong><small>{new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(new Date(`${birthday.date}T12:00:00`))}</small></div>
                  <button className="delete-action" onClick={() => persistBirthdays(birthdays.filter((item) => item.id !== birthday.id))}>Delete</button>
                </article>
              ))}
            </div>
          </section>
        ) : (
          <section className="workspace-page">
            <div className="workspace-heading">
              <div><h2>Settings</h2><p>Control how Daylight behaves on your desktop.</p></div>
            </div>
            <section className="places-settings">
              <div className="settings-section-title">
                <div><strong>Saved places</strong><small>Add as many places as you need. Matching names automatically connect to events.</small></div>
                <span>⌖</span>
              </div>
              <form className="place-create-form" onSubmit={addPlace}>
                <label>
                  <span>Name</span>
                  <input value={newPlaceName} onChange={(event) => setNewPlaceName(event.target.value)} placeholder="LERN 102, Pottruck Gym…" />
                </label>
                <label>
                  <span>Address, coordinates, or Google Maps link</span>
                  <input value={newPlaceAddress} onChange={(event) => setNewPlaceAddress(event.target.value)} placeholder="3700 Walnut St or 39.95, -75.19" />
                </label>
                <label>
                  <span>Type</span>
                  <select value={newPlaceRole} onChange={(event) => setNewPlaceRole(event.target.value as PlaceRole)}>
                    {(["Other", "Home", "Campus", "Dining", "Gym"] as PlaceRole[]).map((role) => <option key={role}>{role}</option>)}
                  </select>
                </label>
                <button className="primary-action">Add place</button>
              </form>
              {newPlaceAddress && (
                <p className="address-detected">
                  ✓ Recognized as {parseAddressInput(newPlaceAddress).format.replace("-", " ")}
                </p>
              )}
              <div className="saved-place-list">
                {places.places.map((place) => (
                  <article key={place.id}>
                    <span>⌖</span>
                    <div><strong>{place.name}</strong><small>{place.address}</small></div>
                    <em>{place.role}</em>
                    <button
                      onClick={() => persistPlaces({ ...places, places: places.places.filter((item) => item.id !== place.id) })}
                    >Delete</button>
                  </article>
                ))}
                {!places.places.length && <p>No places saved yet.</p>}
              </div>
              <label className="city-setting">
                <span>Default city / campus</span>
                <input
                  value={places.city}
                  onChange={(event) => persistPlaces({ ...places, city: event.target.value })}
                  placeholder="Philadelphia, PA"
                />
              </label>
            </section>
            <div className="settings-list">
              <button onClick={toggleLaunchAtLogin}>
                <div><strong>Launch with Windows</strong><small>Open Daylight automatically when you sign in. Toggle off anytime.</small></div>
                <span className={`switch ${launchAtLogin ? "on" : ""}`}><i /></span>
              </button>
              <button onClick={toggleAlwaysOnTop}>
                <div><strong>Keep window on top</strong><small>Keep Daylight above your other windows.</small></div>
                <span className={`switch ${alwaysOnTop ? "on" : ""}`}><i /></span>
              </button>
              <div className="setting-info">
                <div><strong>Calendar and Gmail</strong><small>Google account connection will be added in the next integration phase.</small></div>
                <span>Coming next</span>
              </div>
            </div>
          </section>
        )}
      </main>

      {editingLocation && locationEditingItem && (
        <div className="item-editor-backdrop" onMouseDown={() => setEditingLocation(null)}>
          <form className="item-editor" onSubmit={saveItemLocation} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><small>EDIT LOCATION</small><h2>{locationEditingItem.title}</h2></div>
              <button type="button" onClick={() => setEditingLocation(null)}>×</button>
            </header>
            <p>
              Choose a saved place, paste a one-off address, or leave this item as Anywhere.
              Schedule labels matching a saved place name connect automatically.
            </p>
            <label>
              <span>Location</span>
              <select value={locationPlaceId} onChange={(event) => setLocationPlaceId(event.target.value)}>
                <option value="anywhere">Anywhere / no travel required</option>
                {places.places.map((place) => (
                  <option value={String(place.id)} key={place.id}>{place.name} · {place.role}</option>
                ))}
                <option value="custom">One-off address or coordinates…</option>
              </select>
            </label>
            {locationPlaceId === "custom" && (
              <label>
                <span>Address, coordinates, or Google Maps link</span>
                <input
                  value={customAddress}
                  onChange={(event) => setCustomAddress(event.target.value)}
                  placeholder="Paste the location here"
                  autoFocus
                />
                {customAddress && <small>Recognized as {parseAddressInput(customAddress).format.replace("-", " ")}</small>}
              </label>
            )}
            <footer>
              <button type="button" className="delete-item-action" onClick={deleteEditedItem}>Delete item</button>
              <span>
                <button type="button" className="secondary-action" onClick={() => setEditingLocation(null)}>Cancel</button>
                <button className="primary-action">Save location</button>
              </span>
            </footer>
          </form>
        </div>
      )}

      {sleepOpen && (
        <div className="item-editor-backdrop sleep-backdrop">
          <form className="item-editor sleep-prompt" onSubmit={saveSleep}>
            <header>
              <div>
                <small>NEW DAY · AFTER 8:00 AM</small>
                <h2>When did you sleep?</h2>
              </div>
            </header>
            <p>
              First open for {formatDayKey(dayKey)}. Mark when you fell asleep and woke up.
              Anything before 8:00 AM still belongs to the previous planner day.
            </p>
            <div className="sleep-time-grid">
              <label>
                <span>Fell asleep</span>
                <input type="time" value={sleepStart} onChange={(event) => setSleepStart(event.target.value)} />
              </label>
              <label>
                <span>Woke up</span>
                <input type="time" value={sleepEnd} onChange={(event) => setSleepEnd(event.target.value)} />
              </label>
            </div>
            <SleepTimeline
              interactive
              start={sleepStart}
              end={sleepEnd}
              onChange={(nextStart, nextEnd) => {
                setSleepStart(nextStart);
                setSleepEnd(nextEnd);
              }}
            />
            <footer>
              <button type="button" className="delete-item-action" onClick={skipSleep}>Not now</button>
              <button className="primary-action">Save sleep window</button>
            </footer>
          </form>
        </div>
      )}

      {assistantOpen && (
        <div className="assistant-backdrop" onMouseDown={closeAssistant}>
          <section
            className="assistant-panel"
            aria-label="Daylight assistant"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="assistant-header">
              <div className="assistant-orb">✦</div>
              <div>
                <h2>Daylight Assistant</h2>
                <p><span /> {isGeminiConfigured() ? cloudStatus : "Local assistant · ready"}</p>
              </div>
              <button onClick={closeAssistant} aria-label="Close assistant">×</button>
            </header>

            <div className="assistant-messages">
              {messages.map((message, index) => (
                <div className={`assistant-message ${message.role}`} key={`${message.role}-${index}`}>
                  {message.role === "assistant" && <span className="message-mark">✦</span>}
                  <p>{message.text}</p>
                </div>
              ))}
            </div>

            <div className="assistant-examples">
              {[
                "Calculus Monday and Wednesday 10am–11am in Science Hall room 204",
                "Remind me to email Professor Miller",
                "Add a habit for reading every night",
              ].map((example) => (
                <button key={example} onClick={() => setAssistantInput(example)}>{example}</button>
              ))}
            </div>

            <form className="assistant-compose" onSubmit={askAssistant}>
              <textarea
                value={assistantInput}
                onChange={(event) => setAssistantInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Tell me your schedule..."
                autoFocus
              />
              <div>
                <small>{voiceListening ? "Listening… speak naturally" : "Enter to send · Shift+Enter for a new line"}</small>
                <span className="compose-actions">
                  <button
                    type="button"
                    className={`voice-button ${voiceListening ? "listening" : ""}`}
                    onClick={toggleVoiceInput}
                    aria-label={voiceListening ? "Stop voice typing" : "Start voice typing"}
                    title={voiceListening ? "Stop listening" : "Voice typing"}
                  >{voiceListening ? "■" : "🎙"}</button>
                  <button type="submit" aria-label="Send message">↑</button>
                </span>
              </div>
              {voiceMessage && <p className="voice-message">{voiceMessage}</p>}
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
