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
import { askPlanner, isGeminiConfigured } from "./lib/gemini";
import {
  buildGeminiNewsPrompt,
  goalScoutTargets,
  importGeminiBriefing,
  launchGeminiNewsScout,
  readBriefing,
  runMorningScout,
  splitList,
  type MorningBriefing,
} from "./lib/scout";
import {
  capturePointAfterCountdown,
  macroIsReady,
  readScoutMacroConfig,
  runGeminiScreenMacro,
  writeScoutMacroConfig,
  type ScoutMacroConfig,
} from "./lib/scoutMacro";
import {
  editablePlanFrom,
  parseDeepResearchPlan,
  researchHowToGetThere,
  startGeminiAppDeepResearch,
  type GoalResearchPlan,
} from "./lib/goalResearch";
import { getBundledLifeStory, lifeStoryLoaded } from "./data/lifeStory";
import {
  addGoal,
  ensureUser,
  isFirebaseConfigured,
  loadGoals,
  loadProfile,
  migrateLegacyUserToOwner,
  recordHabitDate,
  removeGoal,
  saveChatDay,
  saveLifeStory,
  saveMemorySummary,
  saveScoutPrompt,
  setGoalStatus,
  updateGoal,
  type Goal,
  type StoredChatMessage,
} from "./lib/firebase";
import {
  loadPlannerState,
  plannerStateIsEmpty,
  savePlannerState,
  type PlannerCloudState,
} from "./lib/plannerSync";
import { bootstrapSyncKeyFromUrl, readSyncKey, writeSyncKey } from "./lib/syncKey";
import {
  buildDaySlotRows,
  CHECK_IN_CATEGORIES,
  DEVICE_LABELS,
  DEVICES,
  fillScreenFreeGaps,
  formatClock,
  formatSlotRange,
  lastAnyDeviceActive,
  mergeCheckInLogs,
  mergeHeartbeats,
  pendingCheckInSlot,
  previousCompletedSlot,
  readCheckIns,
  readCheckInsEnabled,
  readDeviceKind,
  readLocalHeartbeats,
  readSnoozeUntil,
  slotId,
  slotKeyFromDate,
  touchHeartbeat,
  upsertCheckIn,
  writeCheckIns,
  writeCheckInsEnabled,
  writeDeviceKind,
  writeLocalHeartbeats,
  writeSnoozeUntil,
  type CheckInLog,
  type DeviceHeartbeats,
  type DeviceKind,
  type TimeCheckIn,
} from "./lib/checkIns";
import {
  alertPendingCheckIn,
  bringDaylightForward,
  ensureCheckInNotificationPermission,
} from "./lib/checkInAlerts";
import { startVoiceInput, type VoiceSession } from "./speech";
import { VoiceMic } from "./VoiceMic";
import "./App.css";

type VoiceTarget =
  | "assistant"
  | "memory"
  | "goalTitle"
  | "goalSteps"
  | "goalWatch"
  | "goalPeople"
  | "goalNotes"
  | "newTask"
  | "newHabit"
  | "newBirthday"
  | "newPlaceName"
  | "newPlaceAddress"
  | "customAddress"
  | "geminiImport";

type TaskPriority = "red" | "yellow" | "green";

type Task = {
  id: number;
  title: string;
  context: "Home" | "Campus" | "Anywhere";
  points: number;
  done: boolean;
  /** red = do first, yellow = soon, green = can wait */
  priority: TaskPriority;
  address?: string;
  placeId?: number;
};

const PRIORITY_RANK: Record<TaskPriority, number> = { red: 0, yellow: 1, green: 2 };

function normalizeTask(task: Task): Task {
  const priority = task.priority === "red" || task.priority === "green" || task.priority === "yellow"
    ? task.priority
    : "yellow";
  return { ...task, priority };
}

function sortTasksByPriority(list: Task[]) {
  return [...list].sort((first, second) => {
    if (first.done !== second.done) return first.done ? 1 : -1;
    const rank = PRIORITY_RANK[first.priority] - PRIORITY_RANK[second.priority];
    if (rank !== 0) return rank;
    return first.id - second.id;
  });
}

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
  { id: 1, title: "Review calculus notes", context: "Campus", points: 15, done: true, priority: "yellow" },
  { id: 2, title: "Email Professor Miller", context: "Anywhere", points: 10, done: false, priority: "red" },
  { id: 3, title: "Work on portfolio project", context: "Home", points: 25, done: false, priority: "yellow" },
  { id: 4, title: "Pick up groceries", context: "Campus", points: 10, done: false, priority: "green" },
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
  const [tasks, setTasks] = useState<Task[]>(() => {
    const stored = readStored("daylight-tasks", initialTasks);
    return sortTasksByPriority(stored.map((task) => normalizeTask(task as Task)));
  });
  const [newTaskPriority, setNewTaskPriority] = useState<TaskPriority>("yellow");
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
  const [birthdayMonth, setBirthdayMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedBirthdayDay, setSelectedBirthdayDay] = useState<string | null>(null);
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
  const [voiceTarget, setVoiceTarget] = useState<VoiceTarget | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(true);
  const [journal, setJournal] = useState<Journal>(() => readJournal());
  const [sleepOpen, setSleepOpen] = useState(false);
  const [sleepStart, setSleepStart] = useState("23:30");
  const [sleepEnd, setSleepEnd] = useState("07:30");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState(isFirebaseConfigured() ? "Connecting…" : "Local only");
  const [syncMessage, setSyncMessage] = useState("");
  const [syncKeyDraft, setSyncKeyDraft] = useState(() => {
    try {
      bootstrapSyncKeyFromUrl();
      return readSyncKey();
    } catch {
      return "";
    }
  });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [checkIns, setCheckIns] = useState<CheckInLog>(() => readCheckIns());
  const [checkInsEnabled, setCheckInsEnabled] = useState(() => readCheckInsEnabled());
  const [deviceKind, setDeviceKind] = useState<DeviceKind>(() => readDeviceKind());
  const [deviceHeartbeats, setDeviceHeartbeats] = useState<DeviceHeartbeats>(() => readLocalHeartbeats());
  const [pendingCheckIn, setPendingCheckIn] = useState<Omit<TimeCheckIn, "note" | "createdAt" | "skipped" | "inferred"> | null>(null);
  const [checkInDraft, setCheckInDraft] = useState("");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [memorySummary, setMemorySummary] = useState("");
  const [lifeStory, setLifeStory] = useState("");
  const [memorySaveStatus, setMemorySaveStatus] = useState("");
  const [lifeStoryStatus, setLifeStoryStatus] = useState("");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalDeadline, setGoalDeadline] = useState("");
  const [goalSteps, setGoalSteps] = useState("");
  const [goalDomain, setGoalDomain] = useState("research");
  const [goalWatchQueries, setGoalWatchQueries] = useState("");
  const [goalPeople, setGoalPeople] = useState("");
  const [goalNotes, setGoalNotes] = useState("");
  const [researchingGoalId, setResearchingGoalId] = useState<string | null>(null);
  const [researchError, setResearchError] = useState("");
  const [researchDraft, setResearchDraft] = useState<GoalResearchPlan | null>(null);
  const [researchSaving, setResearchSaving] = useState(false);
  const [researchImportOpen, setResearchImportOpen] = useState(false);
  const [researchImportText, setResearchImportText] = useState("");
  const [researchImportGoal, setResearchImportGoal] = useState<Goal | null>(null);
  const [briefing, setBriefing] = useState<MorningBriefing | null>(() => readBriefing(plannerDayKey(new Date())));
  const [scoutStatus, setScoutStatus] = useState<"idle" | "running" | "error">("idle");
  const [scoutMessage, setScoutMessage] = useState("");
  const [scoutPrompt, setScoutPrompt] = useState("");
  const [geminiImportText, setGeminiImportText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [macroConfig, setMacroConfig] = useState<ScoutMacroConfig>(() => readScoutMacroConfig());
  const [macroOpen, setMacroOpen] = useState(false);
  const [captureMessage, setCaptureMessage] = useState("");
  const scoutSyncedFor = useRef<string>("");
  const voiceSession = useRef<VoiceSession | null>(null);
  const habitsRef = useRef(habits);
  const plannerHydrated = useRef(false);
  const plannerSaveTimer = useRef<number | null>(null);
  const plannerSnapshot = useRef({
    tasks,
    habits,
    schedule,
    birthdays,
    places,
    journal,
    checkIns,
    deviceHeartbeats,
  });
  const voiceInputPrefix = useRef("");
  const lastVoiceTarget = useRef<VoiceTarget>("assistant");
  const voiceSessionId = useRef(0);
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
    plannerSnapshot.current = { tasks, habits, schedule, birthdays, places, journal, checkIns, deviceHeartbeats };
  }, [tasks, habits, schedule, birthdays, places, journal, checkIns, deviceHeartbeats]);

  async function connectCloudVault(legacyUserId?: string | null) {
    const ownerId = readSyncKey();
    setSyncKeyDraft(ownerId);
    setCloudUserId(ownerId);
    plannerHydrated.current = false;

    if (legacyUserId) {
      try {
        const migrated = await migrateLegacyUserToOwner(legacyUserId, ownerId);
        if (migrated) setSyncMessage("Moved earlier goals/memory into your shared vault.");
      } catch {
        // Legacy path may be blocked by rules — fine.
      }
    }

    const [profile, storedGoals, planner] = await Promise.all([
      loadProfile(ownerId),
      loadGoals(ownerId),
      loadPlannerState(ownerId),
    ]);
    setMemorySummary(profile.memorySummary);
    const cloudStory = profile.lifeStory?.trim() || "";
    const bundled = getBundledLifeStory();
    if (cloudStory) {
      setLifeStory(cloudStory);
      setLifeStoryStatus("Life story loaded from Firebase.");
    } else if (bundled) {
      setLifeStory(bundled);
      await saveLifeStory(ownerId, bundled);
      setLifeStoryStatus("Autobiography imported from local file and saved to Firebase.");
    } else {
      setLifeStory("");
      setLifeStoryStatus("No life story found yet.");
    }
    setGoals(storedGoals);
    await hydratePlannerFromCloud(ownerId, planner);
    setCloudStatus(`Cloud connected · vault “${ownerId}”`);
  }

  async function hydratePlannerFromCloud(userId: string, planner: PlannerCloudState | null) {
    const local = {
      tasks: plannerSnapshot.current.tasks,
      habits: plannerSnapshot.current.habits,
      schedule: plannerSnapshot.current.schedule,
      birthdays: plannerSnapshot.current.birthdays,
      places: plannerSnapshot.current.places,
      journal: readJournal(),
      checkIns: readCheckIns(),
      deviceHeartbeats: readLocalHeartbeats(),
      lastPlannerDay: readLastPlannerDay(),
    };

    if (plannerStateIsEmpty(planner)) {
      await savePlannerState(userId, local);
      setSyncMessage("Uploaded local todos, habits, and schedule to Firebase.");
    } else if (planner) {
      applyPlannerFromCloud(planner);
      setSyncMessage(`Loaded cloud planner (updated ${new Date(planner.updatedAtMs || Date.now()).toLocaleString()}).`);
    }
    plannerHydrated.current = true;
    // After hydrate, mark gaps since last multi-device activity as screen-free.
    applyScreenFreeGaps();
  }

  function applyPlannerFromCloud(planner: PlannerCloudState) {
    const nextTasks = sortTasksByPriority(
      (planner.tasks as Task[]).map((task) => normalizeTask(task)),
    );
    const nextHabits = (planner.habits as Habit[]) ?? [];
    const nextSchedule = (planner.schedule as ScheduleEvent[]) ?? [];
    const nextBirthdays = (planner.birthdays as Birthday[]) ?? [];
    const nextPlaces = (planner.places as PlaceSettings) ?? initialPlaces;
    const nextJournal = planner.journal ?? {};
    const nextCheckIns = mergeCheckInLogs(readCheckIns(), planner.checkIns ?? {});
    const nextBeats = mergeHeartbeats(readLocalHeartbeats(), planner.deviceHeartbeats ?? {});

    setTasks(nextTasks);
    setHabits(nextHabits);
    setSchedule(nextSchedule);
    setBirthdays(nextBirthdays);
    setPlaces(nextPlaces);
    setJournal(nextJournal);
    setCheckIns(nextCheckIns);
    setDeviceHeartbeats(nextBeats);
    localStorage.setItem("daylight-tasks", JSON.stringify(nextTasks));
    localStorage.setItem("daylight-habits", JSON.stringify(nextHabits));
    localStorage.setItem("daylight-schedule-v2", JSON.stringify(nextSchedule));
    localStorage.setItem("daylight-birthdays", JSON.stringify(nextBirthdays));
    localStorage.setItem("daylight-places", JSON.stringify(nextPlaces));
    writeJournal(nextJournal);
    writeCheckIns(nextCheckIns);
    writeLocalHeartbeats(nextBeats);
    if (planner.lastPlannerDay) writeLastPlannerDay(planner.lastPlannerDay);
  }

  function queuePlannerSync() {
    if (!cloudUserId || !plannerHydrated.current) return;
    if (plannerSaveTimer.current) window.clearTimeout(plannerSaveTimer.current);
    plannerSaveTimer.current = window.setTimeout(() => {
      const snap = plannerSnapshot.current;
      void savePlannerState(cloudUserId, {
        tasks: snap.tasks,
        habits: snap.habits,
        schedule: snap.schedule,
        birthdays: snap.birthdays,
        places: snap.places,
        journal: readJournal(),
        checkIns: readCheckIns(),
        deviceHeartbeats: readLocalHeartbeats(),
        lastPlannerDay: readLastPlannerDay(),
      })
        .then(() => setSyncMessage(`Synced ${new Date().toLocaleTimeString()}`))
        .catch(() => setSyncMessage("Cloud sync failed — check Firestore rules."));
    }, 700);
  }

  function persistCheckIns(next: CheckInLog) {
    // Merge with whatever is already on disk so a slow sync can't wipe another device.
    const merged = mergeCheckInLogs(readCheckIns(), next);
    setCheckIns(merged);
    writeCheckIns(merged);
    plannerSnapshot.current = { ...plannerSnapshot.current, checkIns: merged };
    queuePlannerSync();
  }

  function openLastHalfHourPrompt(opts?: { raiseWindow?: boolean }) {
    const device = readDeviceKind();
    const pending = pendingCheckInSlot(readCheckIns(), device, new Date());
    const slot = pending ?? (() => {
      const { start, end } = previousCompletedSlot(new Date());
      const key = slotKeyFromDate(start);
      return {
        id: slotId(key, device),
        dayKey: plannerDayKey(start),
        slotKey: key,
        slotStart: start.toISOString(),
        slotEnd: end.toISOString(),
        device,
      };
    })();
    setPendingCheckIn(slot);
    setCheckInDraft("");
    if (opts?.raiseWindow) {
      void alertPendingCheckIn({
        id: slot.id,
        rangeLabel: formatSlotRange(slot.slotStart, slot.slotEnd),
        deviceLabel: DEVICE_LABELS[slot.device],
        force: true,
      });
    }
  }

  function persistHeartbeats(next: DeviceHeartbeats) {
    setDeviceHeartbeats(next);
    writeLocalHeartbeats(next);
    plannerSnapshot.current = { ...plannerSnapshot.current, deviceHeartbeats: next };
    queuePlannerSync();
  }

  function applyScreenFreeGaps() {
    if (!readCheckInsEnabled()) return;
    const beats = readLocalHeartbeats();
    const lastActive = lastAnyDeviceActive(beats);
    const before = readCheckIns();
    const filled = fillScreenFreeGaps(before, lastActive, new Date());
    if (JSON.stringify(filled) !== JSON.stringify(before)) {
      persistCheckIns(filled);
    }
  }

  function savePendingCheckIn(note: string, skipped = false) {
    if (!pendingCheckIn) return;
    const entry: TimeCheckIn = {
      ...pendingCheckIn,
      device: pendingCheckIn.device ?? deviceKind,
      note: note.trim(),
      skipped,
      inferred: false,
      createdAt: Date.now(),
    };
    persistCheckIns(upsertCheckIn(readCheckIns(), entry));
    setPendingCheckIn(null);
    setCheckInDraft("");
  }

  async function pullSharedCheckIns() {
    if (!cloudUserId || !plannerHydrated.current) return;
    try {
      const planner = await loadPlannerState(cloudUserId);
      if (!planner) return;
      const mergedLogs = mergeCheckInLogs(readCheckIns(), planner.checkIns ?? {});
      const mergedBeats = mergeHeartbeats(readLocalHeartbeats(), planner.deviceHeartbeats ?? {});
      const logsChanged = JSON.stringify(mergedLogs) !== JSON.stringify(readCheckIns());
      const beatsChanged = JSON.stringify(mergedBeats) !== JSON.stringify(readLocalHeartbeats());
      if (logsChanged) {
        setCheckIns(mergedLogs);
        writeCheckIns(mergedLogs);
        plannerSnapshot.current = { ...plannerSnapshot.current, checkIns: mergedLogs };
      }
      if (beatsChanged) {
        setDeviceHeartbeats(mergedBeats);
        writeLocalHeartbeats(mergedBeats);
        plannerSnapshot.current = { ...plannerSnapshot.current, deviceHeartbeats: mergedBeats };
      }
    } catch {
      // offline / rules — ignore
    }
  }

  function snoozeCheckIn(minutes = 5) {
    writeSnoozeUntil(Date.now() + minutes * 60_000);
    setPendingCheckIn(null);
  }

  function toggleCheckInsEnabled() {
    const next = !checkInsEnabled;
    setCheckInsEnabled(next);
    writeCheckInsEnabled(next);
    if (!next) {
      setPendingCheckIn(null);
      return;
    }
    void ensureCheckInNotificationPermission();
  }

  function changeDeviceKind(next: DeviceKind) {
    setDeviceKind(next);
    writeDeviceKind(next);
  }

  useEffect(() => {
    if (!isFirebaseConfigured()) return;
    ensureUser()
      .then(async (user) => {
        if (!user) {
          setCloudStatus("Firebase config found, but anonymous sign-in failed. Enable Anonymous in Authentication.");
          return;
        }
        await connectCloudVault(user.uid);
      })
      .catch(() => setCloudStatus("Could not reach Firebase. Check Anonymous sign-in and your keys."));
  }, []);

  const today = now;
  const planner = plannerDate(now);
  const dayKey = plannerDayKey(now);
  const historyDayKey = selectedDay || dayKey;
  const historySlotRows = buildDaySlotRows(checkIns, historyDayKey, now);

  useEffect(() => {
    const existing = readBriefing(dayKey);
    if (existing) setBriefing(existing);

    const prompt = buildGeminiNewsPrompt(goals, dayKey, lifeStory);
    setScoutPrompt(prompt);

    const syncKey = `${dayKey}:${goals.map((goal) => goal.id).join(",")}:${prompt.length}:${lifeStory.length}`;
    if (cloudUserId && goalScoutTargets(goals).length && scoutSyncedFor.current !== syncKey) {
      scoutSyncedFor.current = syncKey;
      void saveScoutPrompt(cloudUserId, prompt);
    }

    if (!existing && goalScoutTargets(goals).length) {
      setScoutMessage("Prompt synced. Open in Gemini (Ctrl+V), then paste the JSON reply back here.");
    }
  }, [dayKey, goals, cloudUserId, lifeStory]);
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
    const normalized = sortTasksByPriority(next.map(normalizeTask));
    setTasks(normalized);
    localStorage.setItem("daylight-tasks", JSON.stringify(normalized));
    plannerSnapshot.current = { ...plannerSnapshot.current, tasks: normalized };
    queuePlannerSync();
  }

  function setTaskPriority(id: number, priority: TaskPriority) {
    persistTasks(tasks.map((task) => task.id === id ? { ...task, priority } : task));
  }

  function persistHabits(next: Habit[]) {
    setHabits(next);
    localStorage.setItem("daylight-habits", JSON.stringify(next));
    plannerSnapshot.current = { ...plannerSnapshot.current, habits: next };
    queuePlannerSync();
  }

  function persistSchedule(next: ScheduleEvent[]) {
    const sorted = [...next].sort((first, second) => first.time.localeCompare(second.time));
    setSchedule(sorted);
    localStorage.setItem("daylight-schedule-v2", JSON.stringify(sorted));
    plannerSnapshot.current = { ...plannerSnapshot.current, schedule: sorted };
    queuePlannerSync();
  }

  function persistBirthdays(next: Birthday[]) {
    setBirthdays(next);
    localStorage.setItem("daylight-birthdays", JSON.stringify(next));
    plannerSnapshot.current = { ...plannerSnapshot.current, birthdays: next };
    queuePlannerSync();
  }

  function persistPlaces(next: PlaceSettings) {
    setPlaces(next);
    localStorage.setItem("daylight-places", JSON.stringify(next));
    plannerSnapshot.current = { ...plannerSnapshot.current, places: next };
    queuePlannerSync();
  }

  function persistJournal(next: Journal) {
    writeJournal(next);
    setJournal(next);
    plannerSnapshot.current = { ...plannerSnapshot.current, journal: next };
    queuePlannerSync();
  }

  async function applySyncKey(event?: FormEvent) {
    event?.preventDefault();
    if (!syncKeyDraft.trim()) {
      setAuthError("Enter any passphrase — same one on every device.");
      return;
    }
    setAuthBusy(true);
    setAuthError("");
    try {
      writeSyncKey(syncKeyDraft);
      await connectCloudVault();
      setSyncMessage("Vault key saved. This device now reads/writes that shared cloud folder.");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Could not open vault. Publish firestore.rules for owners/{key}.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function forceUploadLocalPlanner() {
    if (!cloudUserId) return;
    setAuthBusy(true);
    try {
      const snap = plannerSnapshot.current;
      await savePlannerState(cloudUserId, {
        tasks: snap.tasks,
        habits: snap.habits,
        schedule: snap.schedule,
        birthdays: snap.birthdays,
        places: snap.places,
        journal: readJournal(),
        checkIns: readCheckIns(),
        deviceHeartbeats: readLocalHeartbeats(),
        lastPlannerDay: readLastPlannerDay(),
      });
      setSyncMessage(`Forced upload ${new Date().toLocaleTimeString()}`);
    } catch {
      setSyncMessage("Upload failed — publish the owners/* Firestore rules.");
    } finally {
      setAuthBusy(false);
    }
  }

  useEffect(() => {
    if (!checkInsEnabled) return;
    void ensureCheckInNotificationPermission();

    const tick = () => {
      const visible = document.visibilityState !== "hidden";
      void pullSharedCheckIns().then(() => {
        const device = readDeviceKind();
        // Heartbeats only while Daylight is actually in use (visible / focused).
        if (visible) {
          const beats = touchHeartbeat(mergeHeartbeats(readLocalHeartbeats(), deviceHeartbeats), device);
          persistHeartbeats(beats);
          applyScreenFreeGaps();
        }
        if (Date.now() < readSnoozeUntil()) return;
        const pending = pendingCheckInSlot(readCheckIns(), device, new Date());
        if (!pending) return;
        setPendingCheckIn((current) => (current?.id === pending.id ? current : pending));
        void alertPendingCheckIn({
          id: pending.id,
          rangeLabel: formatSlotRange(pending.slotStart, pending.slotEnd),
          deviceLabel: DEVICE_LABELS[pending.device],
        });
      });
    };
    tick();
    const timer = window.setInterval(tick, 20_000);
    const onFocus = () => tick();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [checkInsEnabled, deviceKind, cloudUserId]);

  async function copySyncKey() {
    try {
      await navigator.clipboard.writeText(readSyncKey());
      setSyncMessage("Sync key copied — paste it on your iMac / iPhone.");
    } catch {
      setAuthError("Could not copy — select the key and copy manually.");
    }
  }

  useEffect(() => {
    const last = readLastPlannerDay();
    const currentHabits = habitsRef.current;
    if (last && last !== dayKey) {
      const completed = currentHabits.filter((habit) => habit.done).map((habit) => habit.title);
      const next = readJournal();
      next[last] = { ...emptyDay(), ...next[last], habits: completed };
      persistJournal(next);
      persistHabits(currentHabits.map((habit) => ({ ...habit, done: false })));
    }
    writeLastPlannerDay(dayKey);
    queuePlannerSync();
  }, [dayKey]);

  // Sleep prompt only after vault hydrate (phone was asking before cloud journal arrived).
  useEffect(() => {
    if (isFirebaseConfigured() && !plannerHydrated.current) return;
    const day = journal[dayKey];
    const asked = Boolean(day?.sleepAsked || (day?.sleepStart && day?.sleepEnd));
    setSleepOpen(!asked);
  }, [dayKey, journal, cloudUserId]);

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
      { id: Date.now(), title, context: "Anywhere", points: 10, done: false, priority: newTaskPriority },
    ]);
    setNewTask("");
    setNewTaskPriority("yellow");
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
    persistJournal(updateDay(dayKey, { tasks: titles }));
  }

  function toggleHabit(id: number) {
    const next = habits.map((habit) => habit.id === id ? { ...habit, done: !habit.done } : habit);
    persistHabits(next);
    persistJournal(updateDay(dayKey, {
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
    persistJournal(updateDay(dayKey, {
      sleepStart,
      sleepEnd,
      sleepHours: hours,
      sleepAsked: true,
    }));
    setSleepOpen(false);
  }

  function skipSleep() {
    persistJournal(updateDay(dayKey, { sleepAsked: true }));
    setSleepOpen(false);
  }

  function addHabit(event: FormEvent) {
    event.preventDefault();
    const title = newHabit.trim();
    if (!title) return;
    persistHabits([...habits, { id: Date.now(), title, icon: "○", done: false }]);
    setNewHabit("");
  }

  function birthdayMonthDay(date: string) {
    return date.slice(5);
  }

  function shiftBirthdayMonth(delta: number) {
    const next = new Date(birthdayMonth.getFullYear(), birthdayMonth.getMonth() + delta, 1);
    // Stay inside the current ongoing year only.
    if (next.getFullYear() !== planner.getFullYear()) return;
    setBirthdayMonth(next);
  }

  function addBirthday(event: FormEvent) {
    event.preventDefault();
    const name = newBirthday.trim();
    if (!name || !birthdayDate) return;
    // Store against this year so the calendar reads like a normal year planner.
    const monthDay = birthdayMonthDay(birthdayDate);
    const storedDate = `${planner.getFullYear()}-${monthDay}`;
    persistBirthdays([...birthdays, { id: Date.now(), name, date: storedDate }]);
    setNewBirthday("");
    setBirthdayDate("");
    const month = Number(monthDay.slice(0, 2));
    setBirthdayMonth(new Date(planner.getFullYear(), month - 1, 1));
    setSelectedBirthdayDay(monthDay);
  }

  function describeBirthdayDistance(monthDay: string) {
    const target = new Date(`${planner.getFullYear()}-${monthDay}T12:00:00`);
    const start = new Date(planner.getFullYear(), planner.getMonth(), planner.getDate(), 12);
    const days = Math.round((target.getTime() - start.getTime()) / 86_400_000);
    if (days < 0) return "Earlier this year";
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days <= 7) return `In ${days} days · this week`;
    if (days <= 14) return `In ${days} days · next weekish`;
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "long", day: "numeric" }).format(target);
  }

  const birthdayCalendar = useMemo(() => {
    const year = planner.getFullYear();
    const month = birthdayMonth.getMonth();
    const view = new Date(year, month, 1);
    const firstWeekday = view.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayKey = `${String(planner.getMonth() + 1).padStart(2, "0")}-${String(planner.getDate()).padStart(2, "0")}`;
    const weekStart = new Date(planner.getFullYear(), planner.getMonth(), planner.getDate() - planner.getDay(), 12);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const cells: Array<{
      key: string;
      day: number | null;
      monthDay: string | null;
      people: Birthday[];
      isToday: boolean;
      isThisWeek: boolean;
    }> = [];

    for (let index = 0; index < firstWeekday; index += 1) {
      cells.push({ key: `pad-${index}`, day: null, monthDay: null, people: [], isToday: false, isThisWeek: false });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const monthDay = `${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const absolute = new Date(year, month, day, 12);
      cells.push({
        key: monthDay,
        day,
        monthDay,
        people: birthdays.filter((item) => birthdayMonthDay(item.date) === monthDay),
        isToday: monthDay === todayKey && month === planner.getMonth(),
        isThisWeek: absolute >= weekStart && absolute <= weekEnd,
      });
    }
    return cells;
  }, [birthdayMonth, birthdays, planner]);

  const selectedDayPeople = selectedBirthdayDay
    ? birthdays.filter((item) => birthdayMonthDay(item.date) === selectedBirthdayDay)
    : [];

  const upcomingBirthdays = useMemo(() => {
    const year = planner.getFullYear();
    const start = new Date(year, planner.getMonth(), planner.getDate(), 12);
    return [...birthdays]
      .map((item) => {
        const monthDay = birthdayMonthDay(item.date);
        const target = new Date(`${year}-${monthDay}T12:00:00`);
        let distance = Math.round((target.getTime() - start.getTime()) / 86_400_000);
        // If it already passed this year, show it after the later ones only at the end.
        if (distance < 0) distance += 366;
        return { ...item, monthDay, distance };
      })
      .sort((first, second) => first.distance - second.distance)
      .slice(0, 6);
  }, [birthdays, planner]);

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
      stopVoiceInput();
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
            priority: "yellow" as TaskPriority,
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
      subSteps: splitList(goalSteps),
      domain: goalDomain,
      watchQueries: splitList(goalWatchQueries),
      people: splitList(goalPeople),
      notes: goalNotes.trim(),
    });
    setGoals(await loadGoals(cloudUserId));
    setGoalTitle("");
    setGoalDeadline("");
    setGoalSteps("");
    setGoalDomain("research");
    setGoalWatchQueries("");
    setGoalPeople("");
    setGoalNotes("");
  }

  function persistMacro(next: ScoutMacroConfig) {
    setMacroConfig(next);
    writeScoutMacroConfig(next);
  }

  async function captureMacroPoint(key: keyof ScoutMacroConfig["points"]) {
    setCaptureMessage(`Hover the ${key} spot — capturing in 3…`);
    try {
      const point = await capturePointAfterCountdown(3, (left) => {
        setCaptureMessage(left > 0 ? `Hover the ${key} spot — capturing in ${left}…` : `Captured ${key}.`);
      });
      persistMacro({
        ...macroConfig,
        points: { ...macroConfig.points, [key]: point },
      });
      setCaptureMessage(`${key}: (${point.x}, ${point.y})`);
    } catch (error) {
      setCaptureMessage(error instanceof Error ? error.message : "Capture failed (run the desktop app, not the browser).");
    }
  }

  async function openGeminiNewsFlow() {
    const prompt = scoutPrompt || buildGeminiNewsPrompt(goals, dayKey, lifeStory);
    setScoutPrompt(prompt);
    if (cloudUserId) void saveScoutPrompt(cloudUserId, prompt);
    setScoutStatus("running");

    if (macroIsReady(macroConfig)) {
      setScoutMessage(`Running screen macro… waiting ~${macroConfig.waitSeconds}s for Gemini, then copying the reply.`);
      try {
        const reply = await runGeminiScreenMacro(prompt, macroConfig);
        const next = importGeminiBriefing(reply, dayKey);
        setBriefing(next);
        setScoutStatus("idle");
        setScoutMessage(`Macro imported ${next.opportunities.length} signal${next.opportunities.length === 1 ? "" : "s"}.`);
        setImportOpen(false);
      } catch (error) {
        setScoutStatus("error");
        setScoutMessage(error instanceof Error ? error.message : "Screen macro failed.");
        setImportOpen(true);
      }
      return;
    }

    setScoutMessage("Copied latest goal prompt. Opening Gemini — paste with Ctrl+V, then bring the JSON back. (Or calibrate the screen macro.)");
    try {
      await launchGeminiNewsScout(prompt);
      setScoutStatus("idle");
      setImportOpen(true);
    } catch (error) {
      setScoutStatus("error");
      setScoutMessage(error instanceof Error ? error.message : "Could not open Gemini.");
    }
  }

  function importGeminiReply(event: FormEvent) {
    event.preventDefault();
    if (!geminiImportText.trim()) return;
    try {
      const next = importGeminiBriefing(geminiImportText, dayKey);
      setBriefing(next);
      setGeminiImportText("");
      setImportOpen(false);
      setScoutStatus("idle");
      setScoutMessage(`Imported ${next.opportunities.length} signal${next.opportunities.length === 1 ? "" : "s"} from Gemini.`);
    } catch (error) {
      setScoutStatus("error");
      setScoutMessage(error instanceof Error ? error.message : "Could not parse Gemini JSON.");
    }
  }

  async function runApiScoutFallback() {
    if (scoutStatus === "running") return;
    setScoutStatus("running");
    setScoutMessage("Running API fallback scout…");
    try {
      const next = await runMorningScout(goals, dayKey, lifeStory);
      setBriefing(next);
      setScoutStatus("idle");
      setScoutMessage(next.opportunities.length
        ? `API scout found ${next.opportunities.length} signal${next.opportunities.length === 1 ? "" : "s"}.`
        : "API scout finished — no strong signals.");
    } catch (error) {
      setScoutStatus("error");
      setScoutMessage(error instanceof Error ? error.message : "Scout failed.");
    }
  }

  async function saveMemory(event: FormEvent) {
    event.preventDefault();
    if (!cloudUserId) {
      setMemorySaveStatus("Not connected to Firebase — memory was not saved.");
      return;
    }
    try {
      setMemorySaveStatus("Saving…");
      await saveMemorySummary(cloudUserId, memorySummary);
      setMemorySaveStatus(`Saved to Firebase · ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      setMemorySaveStatus(error instanceof Error ? error.message : "Save failed.");
    }
  }

  async function runGoalResearch(goal: Goal) {
    if (!isGeminiConfigured()) {
      setResearchError("Add VITE_GEMINI_API_KEY to .env so the research agents can run — or use Deep research in Gemini Pro.");
      return;
    }
    setResearchError("");
    setResearchDraft(null);
    setResearchImportOpen(false);
    setResearchingGoalId(goal.id);
    try {
      const plan = await researchHowToGetThere(goal, memorySummary, lifeStory);
      setResearchDraft(editablePlanFrom(plan));
    } catch (error) {
      setResearchError(error instanceof Error ? error.message : "Goal research failed.");
    } finally {
      setResearchingGoalId(null);
    }
  }

  async function runDeepResearchInGemini(goal: Goal) {
    setResearchError("");
    setResearchDraft(null);
    setResearchingGoalId(goal.id);
    setResearchImportGoal(goal);
    try {
      const result = await startGeminiAppDeepResearch(goal, memorySummary, lifeStory);
      if (result.mode === "done" && result.plan) {
        setResearchDraft(editablePlanFrom(result.plan));
        setResearchImportOpen(false);
      } else {
        setResearchImportOpen(true);
        setResearchError("Deep research prompt copied + Gemini opened. Run Deep Research there, then paste the JSON reply below.");
      }
    } catch (error) {
      setResearchImportOpen(true);
      setResearchError(error instanceof Error ? error.message : "Could not launch Gemini deep research.");
    } finally {
      setResearchingGoalId(null);
    }
  }

  function importDeepResearchReply(event: FormEvent) {
    event.preventDefault();
    if (!researchImportGoal || !researchImportText.trim()) return;
    try {
      const plan = parseDeepResearchPlan(researchImportText, researchImportGoal);
      setResearchDraft(editablePlanFrom(plan));
      setResearchImportText("");
      setResearchImportOpen(false);
      setResearchError("");
    } catch (error) {
      setResearchError(error instanceof Error ? error.message : "Could not parse deep research JSON.");
    }
  }

  async function confirmGoalResearch() {
    if (!cloudUserId || !researchDraft) return;
    const draft = researchDraft;
    setResearchSaving(true);
    setResearchError("");
    try {
      await updateGoal(cloudUserId, draft.goalId, {
        watchQueries: draft.proposedWatchQueries,
        people: draft.proposedPeople,
        notes: draft.proposedNotes,
        subSteps: draft.proposedSubSteps,
      });
      const nextGoals = await loadGoals(cloudUserId);
      setGoals(nextGoals);
      const prompt = buildGeminiNewsPrompt(nextGoals, dayKey, lifeStory);
      setScoutPrompt(prompt);
      await saveScoutPrompt(cloudUserId, prompt);
      setResearchDraft(null);
      setScoutMessage(`Goal path saved. Scout prompt updated with ${draft.proposedWatchQueries.length} watch queries.`);
    } catch (error) {
      setResearchError(error instanceof Error ? error.message : "Could not save researched path.");
    } finally {
      setResearchSaving(false);
    }
  }

  function stopVoiceInput() {
    voiceSessionId.current += 1;
    voiceSession.current?.stop();
    voiceSession.current = null;
    setVoiceListening(false);
    setVoiceTarget(null);
  }

  function voiceFieldValue(target: VoiceTarget) {
    switch (target) {
      case "assistant": return assistantInput;
      case "memory": return memorySummary;
      case "goalTitle": return goalTitle;
      case "goalSteps": return goalSteps;
      case "goalWatch": return goalWatchQueries;
      case "goalPeople": return goalPeople;
      case "goalNotes": return goalNotes;
      case "newTask": return newTask;
      case "newHabit": return newHabit;
      case "newBirthday": return newBirthday;
      case "newPlaceName": return newPlaceName;
      case "newPlaceAddress": return newPlaceAddress;
      case "customAddress": return customAddress;
      case "geminiImport": return geminiImportText;
    }
  }

  function setVoiceFieldValue(target: VoiceTarget, value: string) {
    switch (target) {
      case "assistant": setAssistantInput(value); break;
      case "memory": setMemorySummary(value); break;
      case "goalTitle": setGoalTitle(value); break;
      case "goalSteps": setGoalSteps(value); break;
      case "goalWatch": setGoalWatchQueries(value); break;
      case "goalPeople": setGoalPeople(value); break;
      case "goalNotes": setGoalNotes(value); break;
      case "newTask": setNewTask(value); break;
      case "newHabit": setNewHabit(value); break;
      case "newBirthday": setNewBirthday(value); break;
      case "newPlaceName": setNewPlaceName(value); break;
      case "newPlaceAddress": setNewPlaceAddress(value); break;
      case "customAddress": setCustomAddress(value); break;
      case "geminiImport": setGeminiImportText(value); break;
    }
  }

  function rememberVoiceTarget(target: VoiceTarget) {
    lastVoiceTarget.current = target;
  }

  function toggleVoiceFor(target: VoiceTarget = lastVoiceTarget.current) {
    if (voiceListening && voiceTarget === target) {
      stopVoiceInput();
      return;
    }

    voiceSession.current?.stop();
    voiceSession.current = null;
    const sessionToken = voiceSessionId.current + 1;
    voiceSessionId.current = sessionToken;

    lastVoiceTarget.current = target;
    setVoiceMessage("");
    voiceInputPrefix.current = voiceFieldValue(target).trim();
    const session = startVoiceInput({
      onTranscript: (transcript) => {
        if (voiceSessionId.current !== sessionToken) return;
        const prefix = voiceInputPrefix.current;
        setVoiceFieldValue(target, `${prefix}${prefix && transcript ? " " : ""}${transcript}`);
      },
      onEnd: () => {
        if (voiceSessionId.current !== sessionToken) return;
        voiceSession.current = null;
        setVoiceListening(false);
        setVoiceTarget(null);
      },
      onError: (message) => {
        if (voiceSessionId.current !== sessionToken) return;
        setVoiceMessage(message);
      },
    });

    if (!session) {
      setVoiceMessage("Microphone recognition isn’t available here. Click a text box and press Win+H for Windows voice typing.");
      return;
    }

    voiceSession.current = session;
    setVoiceTarget(target);
    setVoiceListening(true);
  }

  function closeAssistant() {
    stopVoiceInput();
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
            {(voiceListening || voiceMessage) && (
              <p className="voice-status">
                {voiceListening ? `Listening for ${voiceTarget ?? "field"}… tap 🎙 to stop` : voiceMessage}
              </p>
            )}
          </div>
          <div className="topbar-actions">
            <VoiceMic
              className="topbar-voice"
              listening={voiceListening}
              active={voiceListening}
              label="Dictate into the last focused field"
              onClick={() => toggleVoiceFor(lastVoiceTarget.current)}
            />
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
                <p>✦ You have {todaysSchedule.length} schedule block{todaysSchedule.length === 1 ? "" : "s"} today.</p>
                {briefing?.opportunities?.length ? (
                  <p>▣ {briefing.opportunities.length} opportunity signal{briefing.opportunities.length === 1 ? "" : "s"} from this morning’s scout.</p>
                ) : (
                  <p>▣ Morning scout will watch your long-term goals for openings and signals.</p>
                )}
                {scoutMessage && <p>{scoutMessage}</p>}
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
            <article className="opportunity-card">
              <div className="opportunity-heading">
                <div>
                  <small>MORNING OPPORTUNITY SCOUT</small>
                  <h3>Signals for your goals</h3>
                </div>
                <div className="opportunity-actions">
                  <button
                    type="button"
                    className="primary-action"
                    disabled={scoutStatus === "running" || !goalScoutTargets(goals).length}
                    onClick={() => void openGeminiNewsFlow()}
                  >
                    {macroIsReady(macroConfig) ? "Run Gemini macro" : "Open in Gemini"}
                  </button>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => setMacroOpen((open) => !open)}
                  >
                    {macroOpen ? "Hide macro" : "Calibrate macro"}
                  </button>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => setImportOpen((open) => !open)}
                  >
                    {importOpen ? "Hide import" : "Paste reply"}
                  </button>
                </div>
              </div>
              {macroOpen && (
                <div className="macro-panel">
                  <p>
                    Machine-local shortcut: click fixed screen coordinates (your pinned Gemini chat → input → Ctrl+V → Enter → wait → copy reply).
                    Recalibrate if the window moves. Works in the Daylight desktop app only.
                  </p>
                  <label className="macro-toggle">
                    <input
                      type="checkbox"
                      checked={macroConfig.enabled}
                      onChange={(event) => persistMacro({ ...macroConfig, enabled: event.target.checked })}
                    />
                    Enable screen macro for “Run Gemini macro”
                  </label>
                  <label className="macro-toggle">
                    <input
                      type="checkbox"
                      checked={macroConfig.openGeminiFirst}
                      onChange={(event) => persistMacro({ ...macroConfig, openGeminiFirst: event.target.checked })}
                    />
                    Open gemini.google.com first
                  </label>
                  <label className="macro-wait">
                    Wait for answer (seconds)
                    <input
                      type="number"
                      min={5}
                      max={300}
                      value={macroConfig.waitSeconds}
                      onChange={(event) => persistMacro({
                        ...macroConfig,
                        waitSeconds: Number(event.target.value) || 45,
                      })}
                    />
                  </label>
                  <div className="macro-points">
                    {([
                      ["chat", "1. Pinned Gemini chat"],
                      ["input", "2. Message input box"],
                      ["response", "3. Reply text area"],
                    ] as const).map(([key, label]) => (
                      <button key={key} type="button" className="ghost-action" onClick={() => void captureMacroPoint(key)}>
                        {label}
                        {macroConfig.points[key]
                          ? ` · (${macroConfig.points[key]!.x}, ${macroConfig.points[key]!.y})`
                          : " · not set"}
                      </button>
                    ))}
                  </div>
                  {captureMessage && <p className="opportunity-footnote">{captureMessage}</p>}
                </div>
              )}
              <p className="opportunity-summary">
                {briefing?.summary
                  || (goalScoutTargets(goals).length
                    ? "Goals stay in Firebase. Each morning we rebuild the scout prompt from them, copy it, and open Gemini so your subscription can deep-search the web."
                    : "Add a long-term goal with watch topics / people in Goals first.")}
              </p>
              {briefing?.nextActions?.length ? (
                <div className="next-actions">
                  <small>NEXT REACTIONS</small>
                  <ol>
                    {briefing.nextActions.map((action) => <li key={action}>{action}</li>)}
                  </ol>
                </div>
              ) : null}
              {importOpen && (
                <form className="gemini-import" onSubmit={importGeminiReply}>
                  <div className="voice-field">
                    <textarea
                      value={geminiImportText}
                      onChange={(event) => setGeminiImportText(event.target.value)}
                      onFocus={() => rememberVoiceTarget("geminiImport")}
                      placeholder='Paste Gemini’s JSON reply here… { "summary": "...", "nextActions": [...], "opportunities": [...] }'
                    />
                    <VoiceMic
                      listening={voiceListening}
                      active={voiceTarget === "geminiImport"}
                      onClick={() => toggleVoiceFor("geminiImport")}
                    />
                  </div>
                  <div className="opportunity-actions">
                    <button className="primary-action" type="submit">Import briefing</button>
                    <button type="button" className="ghost-action" onClick={() => void runApiScoutFallback()}>
                      API fallback
                    </button>
                  </div>
                </form>
              )}
              {briefing?.opportunities?.length ? (
                <div className="opportunity-list">
                  {briefing.opportunities.map((item) => (
                    <article key={item.id}>
                      <div>
                        <small>{item.kind}{item.goalTitle ? ` · ${item.goalTitle}` : ""}</small>
                        <strong>{item.title}</strong>
                        <p>{item.summary}</p>
                        {item.whyItMatters && <p className="opportunity-why">{item.whyItMatters}</p>}
                        {item.nextSteps?.length > 0 && (
                          <p className="opportunity-why">Next: {item.nextSteps.join(" · ")}</p>
                        )}
                      </div>
                      {item.url && (
                        <a href={item.url} target="_blank" rel="noreferrer">Open</a>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="empty-note">
                  {scoutMessage || "No briefing yet — Open in Gemini, then Paste reply."}
                </p>
              )}
              <p className="opportunity-footnote">
                {scoutMessage ? `${scoutMessage} · ` : ""}
                {briefing?.sourcesNote
                  || "Preferred path: Gemini app with your Pro subscription. Prompt is synced to Firebase whenever goals change."}
              </p>
            </article>

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
                <div>
                  <h2>Today’s tasks</h2>
                  <span>
                    {completedCount} of {tasks.length} complete
                    {" · "}
                    {tasks.filter((task) => !task.done && task.priority === "red").length} code red
                  </span>
                </div>
                <span className="points-pill">✦ {completedPoints} pts</span>
              </div>

              <form className="quick-add" onSubmit={addTask}>
                <span>＋</span>
                <input
                  value={newTask}
                  onChange={(event) => setNewTask(event.target.value)}
                  onFocus={() => rememberVoiceTarget("newTask")}
                  placeholder="Add a task, reminder, or idea..."
                  aria-label="New task"
                />
                <div className="priority-picker" aria-label="New task priority">
                  {([
                    ["red", "Code red"],
                    ["yellow", "Code yellow"],
                    ["green", "Code green"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`priority-dot ${value} ${newTaskPriority === value ? "active" : ""}`}
                      title={label}
                      aria-label={label}
                      onClick={() => setNewTaskPriority(value)}
                    />
                  ))}
                </div>
                <VoiceMic
                  listening={voiceListening}
                  active={voiceTarget === "newTask"}
                  onClick={() => toggleVoiceFor("newTask")}
                />
                <kbd>Enter</kbd>
              </form>

              <div className="task-list">
                {(["red", "yellow", "green"] as TaskPriority[]).map((priority) => {
                  const group = tasks.filter((task) => !task.done && task.priority === priority);
                  if (!group.length) return null;
                  const label = priority === "red" ? "Code red · do first" : priority === "yellow" ? "Code yellow · soon" : "Code green · can wait";
                  return (
                    <div className={`priority-group ${priority}`} key={priority}>
                      <small>{label}</small>
                      {group.map((task) => (
                        <div className={`task-row priority-${task.priority}`} key={task.id}>
                          <button className="check" onClick={() => toggleTask(task.id)} aria-label={`Mark ${task.title}`}>
                            {task.done ? "✓" : ""}
                          </button>
                          <div className="task-title">
                            <strong>{task.title}</strong>
                            <small>{itemLocationLabel(task, task.context === "Anywhere" ? "Anywhere" : task.context)}</small>
                          </div>
                          <div className="priority-picker compact" aria-label={`Priority for ${task.title}`}>
                            {(["red", "yellow", "green"] as TaskPriority[]).map((value) => (
                              <button
                                key={value}
                                type="button"
                                className={`priority-dot ${value} ${task.priority === value ? "active" : ""}`}
                                title={value === "red" ? "Code red" : value === "yellow" ? "Code yellow" : "Code green"}
                                aria-label={`Set ${value} priority`}
                                onClick={() => setTaskPriority(task.id, value)}
                              />
                            ))}
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
                  );
                })}
                {tasks.some((task) => task.done) && (
                  <div className="priority-group done-group">
                    <small>Completed</small>
                    {tasks.filter((task) => task.done).map((task) => (
                      <div className={`task-row done priority-${task.priority}`} key={task.id}>
                        <button className="check" onClick={() => toggleTask(task.id)} aria-label={`Mark ${task.title}`}>
                          ✓
                        </button>
                        <div className="task-title">
                          <strong>{task.title}</strong>
                          <small>{itemLocationLabel(task, task.context === "Anywhere" ? "Anywhere" : task.context)}</small>
                        </div>
                        <div className="priority-picker compact">
                          {(["red", "yellow", "green"] as TaskPriority[]).map((value) => (
                            <button
                              key={value}
                              type="button"
                              className={`priority-dot ${value} ${task.priority === value ? "active" : ""}`}
                              onClick={() => setTaskPriority(task.id, value)}
                            />
                          ))}
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
                )}
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
              <div>
                <small>UPCOMING</small>
                <strong>{upcomingBirthdays[0]?.name ?? "Add a birthday"}{upcomingBirthdays[0] ? "’s birthday" : ""}</strong>
                <p>
                  {upcomingBirthdays[0]
                    ? new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(new Date(`${upcomingBirthdays[0].date}T12:00:00`))
                    : "Never forget an important date."}
                </p>
              </div>
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
                <p>
                  {cloudStatus}. Goals, todos, habits, schedule, birthdays, places, and journal sync when you sign in. They also guide Gemini chat and the morning scout
                  (openings, papers, events, public signals).
                </p>
              </div>
              <button
                type="button"
                className="primary-action"
                disabled={scoutStatus === "running" || !goalScoutTargets(goals).length}
                onClick={() => void openGeminiNewsFlow()}
              >
                Open scout in Gemini
              </button>
            </div>
            {!isFirebaseConfigured() ? (
              <div className="plan-empty compact">
                <h3>Cloud planner is not connected</h3>
                <p>Copy `.env.example` to `.env`, add your Firebase web config and Gemini key, then restart Daylight. Enable Anonymous sign-in in Firebase.</p>
              </div>
            ) : (
              <>
                <form className="workspace-form memory-form" onSubmit={saveMemory}>
                  <div className="voice-field">
                    <textarea
                      value={memorySummary}
                      onChange={(event) => {
                        setMemorySummary(event.target.value);
                        setMemorySaveStatus("");
                      }}
                      onFocus={() => rememberVoiceTarget("memory")}
                      placeholder="Long-term memory: semester goals, constraints, people, preferences..."
                    />
                    <VoiceMic
                      listening={voiceListening}
                      active={voiceTarget === "memory"}
                      onClick={() => toggleVoiceFor("memory")}
                    />
                  </div>
                  <button className="primary-action">Save memory</button>
                </form>
                {memorySaveStatus && <p className="empty-note">{memorySaveStatus}</p>}
                <div className="life-story-bar">
                  <p className="empty-note">
                    {lifeStoryStatus
                      || (lifeStoryLoaded()
                        ? "Local autobiography is available for scout + research agents."
                        : "Add src/data/AUTOBIOGRAPHY.md to give agents your life story.")}
                    {lifeStory ? ` · ${Math.round(lifeStory.length / 1000)}k chars loaded.` : ""}
                  </p>
                  <button
                    type="button"
                    className="ghost-action"
                    disabled={!cloudUserId || !getBundledLifeStory()}
                    onClick={() => {
                      if (!cloudUserId) return;
                      const bundled = getBundledLifeStory();
                      setLifeStory(bundled);
                      void saveLifeStory(cloudUserId, bundled).then(() => {
                        setLifeStoryStatus("Re-synced autobiography to Firebase.");
                      });
                    }}
                  >
                    Re-sync autobiography
                  </button>
                </div>
                <form className="workspace-form goal-form rich" onSubmit={createGoal}>
                  <div className="voice-field">
                    <input
                      value={goalTitle}
                      onChange={(event) => setGoalTitle(event.target.value)}
                      onFocus={() => rememberVoiceTarget("goalTitle")}
                      placeholder="Goal, e.g. Research assistant in robotics lab"
                      required
                    />
                    <VoiceMic listening={voiceListening} active={voiceTarget === "goalTitle"} onClick={() => toggleVoiceFor("goalTitle")} />
                  </div>
                  <select value={goalDomain} onChange={(event) => setGoalDomain(event.target.value)}>
                    <option value="research">Research</option>
                    <option value="career">Career</option>
                    <option value="academic">Academic</option>
                    <option value="personal">Personal</option>
                    <option value="other">Other</option>
                  </select>
                  <input type="date" value={goalDeadline} onChange={(event) => setGoalDeadline(event.target.value)} />
                  <div className="voice-field">
                    <input
                      value={goalSteps}
                      onChange={(event) => setGoalSteps(event.target.value)}
                      onFocus={() => rememberVoiceTarget("goalSteps")}
                      placeholder="Sub-steps, commas"
                    />
                    <VoiceMic listening={voiceListening} active={voiceTarget === "goalSteps"} onClick={() => toggleVoiceFor("goalSteps")} />
                  </div>
                  <div className="voice-field wide">
                    <input
                      value={goalWatchQueries}
                      onChange={(event) => setGoalWatchQueries(event.target.value)}
                      onFocus={() => rememberVoiceTarget("goalWatch")}
                      placeholder="Watch topics, e.g. robotics RA opening, CMU RI hiring"
                    />
                    <VoiceMic listening={voiceListening} active={voiceTarget === "goalWatch"} onClick={() => toggleVoiceFor("goalWatch")} />
                  </div>
                  <div className="voice-field wide">
                    <input
                      value={goalPeople}
                      onChange={(event) => setGoalPeople(event.target.value)}
                      onFocus={() => rememberVoiceTarget("goalPeople")}
                      placeholder="People / labs / orgs to watch"
                    />
                    <VoiceMic listening={voiceListening} active={voiceTarget === "goalPeople"} onClick={() => toggleVoiceFor("goalPeople")} />
                  </div>
                  <div className="voice-field wide">
                    <input
                      value={goalNotes}
                      onChange={(event) => setGoalNotes(event.target.value)}
                      onFocus={() => rememberVoiceTarget("goalNotes")}
                      placeholder="Why this matters / what a good opportunity looks like"
                    />
                    <VoiceMic listening={voiceListening} active={voiceTarget === "goalNotes"} onClick={() => toggleVoiceFor("goalNotes")} />
                  </div>
                  <button className="primary-action">Add goal</button>
                </form>
                <p className="empty-note">
                  Tip: add “work in Marsden lab”, then use
                  <strong> Deep research in Gemini Pro</strong> (best search) or
                  <strong> Research how to get there</strong> (5 API agents: academic fit, warm ties, referrals, events, industry).
                  Confirm before it updates the morning scout.
                  {scoutMessage ? ` ${scoutMessage}` : ""}
                </p>
                {researchError && <p className="plan-error">{researchError}</p>}
                {researchImportOpen && researchImportGoal && (
                  <form className="research-panel" onSubmit={importDeepResearchReply}>
                    <header>
                      <div>
                        <small>GEMINI PRO DEEP RESEARCH IMPORT</small>
                        <h3>{researchImportGoal.title}</h3>
                        <p>Paste Gemini’s JSON reply after Deep Research finishes.</p>
                      </div>
                      <button type="button" className="ghost-action" onClick={() => setResearchImportOpen(false)}>Hide</button>
                    </header>
                    <textarea
                      value={researchImportText}
                      onChange={(event) => setResearchImportText(event.target.value)}
                      placeholder='Paste JSON with deepBriefing.currentWork / alignment / referrals / events …'
                    />
                    <footer>
                      <button className="primary-action" type="submit">Import deep research</button>
                    </footer>
                  </form>
                )}
                {researchDraft && (
                  <section className="research-panel">
                    <header>
                      <div>
                        <small>GOAL PATH RESEARCH · {researchDraft.source}</small>
                        <h3>{researchDraft.goalTitle}</h3>
                        <p>{researchDraft.summary}</p>
                      </div>
                      <button type="button" className="ghost-action" onClick={() => setResearchDraft(null)}>Close</button>
                    </header>

                    <div className="research-briefing">
                      {([
                        ["currentWork", "What they’re working on"],
                        ["alignment", "How you align"],
                        ["referrals", "Referrals / warm paths"],
                        ["events", "Events / networking"],
                      ] as const).map(([key, label]) => (
                        <article key={key}>
                          <small>{label}</small>
                          {researchDraft.deepBriefing[key].length ? (
                            <ul>
                              {researchDraft.deepBriefing[key].map((item) => <li key={item}>{item}</li>)}
                            </ul>
                          ) : (
                            <p>No items yet for this section.</p>
                          )}
                        </article>
                      ))}
                    </div>

                    <div className="research-lenses five">
                      {researchDraft.lenses.map((lens) => (
                        <article key={lens.lens}>
                          <small>{lens.lens.replace(/_/g, " ")} · {Math.round(lens.weight * 100)}%</small>
                          <p>{lens.rationale || "No rationale returned."}</p>
                          {lens.signals.length > 0 && (
                            <ul>{lens.signals.slice(0, 4).map((signal) => <li key={signal}>{signal}</li>)}</ul>
                          )}
                          {lens.nextMoves.length > 0 && (
                            <ul className="research-moves">
                              {lens.nextMoves.slice(0, 3).map((move) => <li key={move}>{move}</li>)}
                            </ul>
                          )}
                        </article>
                      ))}
                    </div>

                    <label>
                      <span>People / labs / orgs (comma-separated) — edit before saving</span>
                      <textarea
                        value={researchDraft.proposedPeople.join(", ")}
                        onChange={(event) => setResearchDraft({
                          ...researchDraft,
                          proposedPeople: splitList(event.target.value),
                        })}
                      />
                    </label>
                    <label>
                      <span>Watch queries (comma-separated)</span>
                      <textarea
                        value={researchDraft.proposedWatchQueries.join(", ")}
                        onChange={(event) => setResearchDraft({
                          ...researchDraft,
                          proposedWatchQueries: splitList(event.target.value),
                        })}
                      />
                    </label>
                    <label>
                      <span>Next sub-steps (comma-separated)</span>
                      <textarea
                        value={researchDraft.proposedSubSteps.join(", ")}
                        onChange={(event) => setResearchDraft({
                          ...researchDraft,
                          proposedSubSteps: splitList(event.target.value),
                        })}
                      />
                    </label>
                    <label>
                      <span>Notes / path strategy</span>
                      <textarea
                        value={researchDraft.proposedNotes}
                        onChange={(event) => setResearchDraft({
                          ...researchDraft,
                          proposedNotes: event.target.value,
                        })}
                      />
                    </label>

                    <footer>
                      <button type="button" className="ghost-action" onClick={() => setResearchDraft(null)}>Discard</button>
                      <button
                        type="button"
                        className="primary-action"
                        disabled={researchSaving}
                        onClick={() => void confirmGoalResearch()}
                      >
                        {researchSaving ? "Saving…" : "Confirm path → update goal + scout"}
                      </button>
                    </footer>
                  </section>
                )}
                <div className="goal-list">
                  {goals.map((goal) => (
                    <article key={goal.id}>
                      <div>
                        <strong>{goal.title}</strong>
                        <small>
                          {goal.status}
                          {goal.domain ? ` · ${goal.domain}` : ""}
                          {goal.deadline ? ` · due ${goal.deadline}` : ""}
                        </small>
                        {goal.subSteps.length > 0 && <p>{goal.subSteps.join(" · ")}</p>}
                        {goal.watchQueries.length > 0 && <p>Watch: {goal.watchQueries.join(" · ")}</p>}
                        {goal.people.length > 0 && <p>People: {goal.people.join(" · ")}</p>}
                        {goal.notes && <p>{goal.notes}</p>}
                      </div>
                      <div className="goal-actions">
                        {goal.status !== "done" && (
                          <>
                            <button
                              type="button"
                              disabled={researchingGoalId === goal.id}
                              onClick={() => void runDeepResearchInGemini(goal)}
                            >
                              {researchingGoalId === goal.id ? "Deep researching…" : "Deep research in Gemini Pro"}
                            </button>
                            <button
                              type="button"
                              disabled={researchingGoalId === goal.id}
                              onClick={() => void runGoalResearch(goal)}
                            >
                              {researchingGoalId === goal.id ? "Researching…" : "5-agent API research"}
                            </button>
                            <button onClick={async () => {
                              if (!cloudUserId) return;
                              await setGoalStatus(cloudUserId, goal.id, "done");
                              setGoals(await loadGoals(cloudUserId));
                            }}>Done</button>
                          </>
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
              <div className="voice-field">
                <input
                  value={newHabit}
                  onChange={(event) => setNewHabit(event.target.value)}
                  onFocus={() => rememberVoiceTarget("newHabit")}
                  placeholder="New habit, e.g. Read for 20 minutes"
                />
                <VoiceMic listening={voiceListening} active={voiceTarget === "newHabit"} onClick={() => toggleVoiceFor("newHabit")} />
              </div>
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
                <p>Heatmaps, sleep, and your Phone / Laptop / iMac time grid. Day rolls at 8:00 AM.</p>
              </div>
            </div>

            <article className="checkin-card">
              <div className="section-heading">
                <div>
                  <h2>Device time grid</h2>
                  <span>
                    {historyDayKey === dayKey ? "Today" : formatDayKey(historyDayKey)}
                    {" · "}Now {formatClock(now)} · this device: {DEVICE_LABELS[deviceKind]}
                    {checkInsEnabled ? " · 30-min blocks" : " · paused"}
                  </span>
                </div>
                {checkInsEnabled && historyDayKey === dayKey && (
                  <button
                    type="button"
                    className="primary-action"
                    onClick={openLastHalfHourPrompt}
                  >
                    Log last half hour
                  </button>
                )}
              </div>
              {historySlotRows.length ? (
                <div className="checkin-grid-wrap">
                  <div className="checkin-grid-head">
                    <span>Time</span>
                    {DEVICES.map((device) => (
                      <span key={device} className={device === deviceKind ? "current-device" : ""}>
                        {DEVICE_LABELS[device]}
                      </span>
                    ))}
                  </div>
                  <div className="checkin-grid">
                    {historySlotRows.map((row) => {
                      const anyDevice = DEVICES.some((device) => row.byDevice[device]);
                      if (row.screenFree && !anyDevice) {
                        return (
                          <div className="checkin-row screen-free" key={row.slotStart}>
                            <strong>{row.label}</strong>
                            <p className="screen-free-note">Screen-free · no Daylight open on phone / laptop / iMac</p>
                          </div>
                        );
                      }
                      return (
                        <div className="checkin-row" key={row.slotStart}>
                          <strong>{row.label}</strong>
                          {DEVICES.map((device) => {
                            const entry = row.byDevice[device];
                            return (
                              <p key={device} className={!entry ? "muted" : entry.skipped ? "skipped" : ""}>
                                {entry ? (entry.skipped ? "Skipped" : entry.note || "—") : "—"}
                              </p>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="empty-note">
                  {checkInsEnabled
                    ? "No blocks for this day yet."
                    : "Turn on 30-minute check-ins in Settings."}
                </p>
              )}
            </article>

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
              <div>
                <h2>Birthdays</h2>
                <p>
                  {planner.getFullYear()} calendar — same idea as a normal year view. Flip months to see who’s coming up
                  (this week, next week, later).
                </p>
              </div>
              <button
                type="button"
                className="ghost-action"
                onClick={() => setBirthdayMonth(new Date(planner.getFullYear(), planner.getMonth(), 1))}
              >
                This month
              </button>
            </div>
            <form className="workspace-form birthday-form" onSubmit={addBirthday}>
              <div className="voice-field">
                <input
                  value={newBirthday}
                  onChange={(event) => setNewBirthday(event.target.value)}
                  onFocus={() => rememberVoiceTarget("newBirthday")}
                  placeholder="Friend’s name"
                />
                <VoiceMic listening={voiceListening} active={voiceTarget === "newBirthday"} onClick={() => toggleVoiceFor("newBirthday")} />
              </div>
              <input
                type="date"
                value={birthdayDate}
                min={`${planner.getFullYear()}-01-01`}
                max={`${planner.getFullYear()}-12-31`}
                onChange={(event) => setBirthdayDate(event.target.value)}
              />
              <button className="primary-action">Add birthday</button>
            </form>

            <div className="birthday-layout">
              <section className="birthday-calendar" aria-label={`${planner.getFullYear()} birthday calendar`}>
                <div className="birthday-calendar-header">
                  <button
                    type="button"
                    className="ghost-action"
                    disabled={birthdayMonth.getMonth() === 0}
                    onClick={() => shiftBirthdayMonth(-1)}
                  >
                    ‹
                  </button>
                  <div className="birthday-calendar-title">
                    <strong>
                      {new Intl.DateTimeFormat("en-US", { month: "long" }).format(
                        new Date(planner.getFullYear(), birthdayMonth.getMonth(), 1),
                      )}
                    </strong>
                    <small>{planner.getFullYear()}</small>
                  </div>
                  <button
                    type="button"
                    className="ghost-action"
                    disabled={birthdayMonth.getMonth() === 11}
                    onClick={() => shiftBirthdayMonth(1)}
                  >
                    ›
                  </button>
                </div>
                <div className="birthday-weekdays" aria-hidden="true">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                <div className="birthday-grid">
                  {birthdayCalendar.map((cell) => (
                    cell.day === null ? (
                      <div className="birthday-cell empty" key={cell.key} />
                    ) : (
                      <button
                        type="button"
                        key={cell.key}
                        className={[
                          "birthday-cell",
                          cell.people.length ? "has-people" : "",
                          cell.isThisWeek ? "this-week" : "",
                          cell.isToday ? "today" : "",
                          selectedBirthdayDay === cell.monthDay ? "selected" : "",
                        ].filter(Boolean).join(" ")}
                        onClick={() => setSelectedBirthdayDay(cell.monthDay)}
                      >
                        <span className="birthday-day-number">{cell.day}</span>
                        {cell.people.length > 0 && (
                          <span className="birthday-names">
                            {cell.people.slice(0, 2).map((person) => person.name.split(" ")[0]).join(", ")}
                            {cell.people.length > 2 ? ` +${cell.people.length - 2}` : ""}
                          </span>
                        )}
                      </button>
                    )
                  ))}
                </div>
              </section>

              <aside className="birthday-side">
                <article className="birthday-day-detail">
                  <small>SELECTED DAY</small>
                  <strong>
                    {selectedBirthdayDay
                      ? new Intl.DateTimeFormat("en-US", {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      }).format(new Date(`${planner.getFullYear()}-${selectedBirthdayDay}T12:00:00`))
                      : "Pick a day"}
                  </strong>
                  {selectedBirthdayDay && (
                    <p className="empty-note">{describeBirthdayDistance(selectedBirthdayDay)}</p>
                  )}
                  {selectedDayPeople.length ? (
                    <div className="birthday-list-page compact">
                      {selectedDayPeople.map((birthday) => (
                        <article key={birthday.id}>
                          <span>☆</span>
                          <div>
                            <strong>{birthday.name}</strong>
                            <small>{describeBirthdayDistance(birthdayMonthDay(birthday.date))}</small>
                          </div>
                          <button
                            className="delete-action"
                            onClick={() => persistBirthdays(birthdays.filter((item) => item.id !== birthday.id))}
                          >
                            Delete
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-note">
                      {selectedBirthdayDay ? "No birthdays on this day." : "Click a marked day to see who’s celebrating."}
                    </p>
                  )}
                </article>

                <article className="birthday-day-detail">
                  <small>COMING UP IN {planner.getFullYear()}</small>
                  <strong>From today forward</strong>
                  <div className="birthday-list-page compact">
                    {upcomingBirthdays.map((birthday) => (
                      <article key={birthday.id}>
                        <span>☆</span>
                        <div>
                          <strong>{birthday.name}</strong>
                          <small>{describeBirthdayDistance(birthday.monthDay)}</small>
                        </div>
                        <button
                          type="button"
                          className="ghost-action"
                          onClick={() => {
                            const month = Number(birthday.monthDay.slice(0, 2));
                            setBirthdayMonth(new Date(planner.getFullYear(), month - 1, 1));
                            setSelectedBirthdayDay(birthday.monthDay);
                          }}
                        >
                          Show
                        </button>
                      </article>
                    ))}
                    {!upcomingBirthdays.length && <p className="empty-note">No birthdays saved yet.</p>}
                  </div>
                </article>
              </aside>
            </div>
          </section>
        ) : (
          <section className="workspace-page">
            <div className="workspace-heading">
              <div><h2>Settings</h2><p>Control how Daylight behaves on your desktop.</p></div>
            </div>
            <section className="places-settings">
              <div className="settings-section-title">
                <div>
                  <strong>This device</strong>
                  <small>Used for the 3-column time grid (Phone / Laptop / iMac). Pick what this machine is.</small>
                </div>
                <span>⌚</span>
              </div>
              <div className="device-kind-row">
                {DEVICES.map((device) => (
                  <button
                    key={device}
                    type="button"
                    className={`device-kind-btn ${deviceKind === device ? "active" : ""}`}
                    onClick={() => changeDeviceKind(device)}
                  >
                    {DEVICE_LABELS[device]}
                  </button>
                ))}
              </div>
              <button type="button" className="settings-inline-toggle" onClick={toggleCheckInsEnabled}>
                <div>
                  <strong>30-minute check-ins</strong>
                  <small>
                    Every half hour: OS notification + Daylight jumps to the front so you can tap a category.
                    Allow notifications when asked. On phone, keep the Home Screen app running in the background.
                  </small>
                </div>
                <span className={`switch ${checkInsEnabled ? "on" : ""}`}><i /></span>
              </button>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => void ensureCheckInNotificationPermission()}
                >
                  Allow check-in notifications
                </button>
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => {
                    void (async () => {
                      await ensureCheckInNotificationPermission();
                      await bringDaylightForward();
                      openLastHalfHourPrompt({ raiseWindow: true });
                    })();
                  }}
                >
                  Test: bring Daylight to front
                </button>
              </div>
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "#6a7c72", lineHeight: 1.4 }}>
                Desktop app only: the whole Daylight window should jump above Chrome/other apps for ~20s.
                Restart with <code>npm run tauri dev</code> after updating. Browser tabs cannot steal focus.
              </p>
            </section>
            <section className="places-settings sync-settings">
              <div className="settings-section-title">
                <div>
                  <strong>Cloud sync</strong>
                  <small>
                    No email account needed. Use the same vault key on every device and they share one Firebase folder.
                  </small>
                </div>
                <span>☁</span>
              </div>
              <p className="sync-status-line">{cloudStatus}</p>
              {syncMessage && <p className="sync-status-line">{syncMessage}</p>}
              <form className="sync-auth-form" onSubmit={applySyncKey}>
                <label className="sync-key-field">
                  <span>Vault key (same on PC, iMac, iPhone)</span>
                  <input
                    value={syncKeyDraft}
                    onChange={(event) => setSyncKeyDraft(event.target.value)}
                    placeholder="e.g. nikita-daylight"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <div className="sync-auth-actions">
                  <button className="primary-action" type="submit" disabled={authBusy}>Save key</button>
                  <button className="secondary-action" type="button" disabled={authBusy} onClick={copySyncKey}>
                    Copy key
                  </button>
                  <button className="secondary-action" type="button" disabled={authBusy || !cloudUserId} onClick={forceUploadLocalPlanner}>
                    Push this device to cloud
                  </button>
                </div>
              </form>
              {authError && <p className="places-warning">{authError}</p>}
              <p className="empty-note">
                If you see “insufficient permissions”, open{" "}
                <a href="https://console.firebase.google.com/project/daylight-fc0c2/firestore/rules" target="_blank" rel="noreferrer">
                  Firestore Rules
                </a>
                , paste the contents of <code>firestore.rules</code> from this project, then Publish.
                Also keep Authentication → Anonymous enabled.
              </p>
            </section>
            <section className="places-settings">
              <div className="settings-section-title">
                <div><strong>Saved places</strong><small>Add as many places as you need. Matching names automatically connect to events.</small></div>
                <span>⌖</span>
              </div>
              <form className="place-create-form" onSubmit={addPlace}>
                <label>
                  <span>Name</span>
                  <div className="voice-field">
                    <input
                      value={newPlaceName}
                      onChange={(event) => setNewPlaceName(event.target.value)}
                      onFocus={() => rememberVoiceTarget("newPlaceName")}
                      placeholder="LERN 102, Pottruck Gym…"
                    />
                    <VoiceMic listening={voiceListening} active={voiceTarget === "newPlaceName"} onClick={() => toggleVoiceFor("newPlaceName")} />
                  </div>
                </label>
                <label>
                  <span>Address, coordinates, or Google Maps link</span>
                  <div className="voice-field">
                    <input
                      value={newPlaceAddress}
                      onChange={(event) => setNewPlaceAddress(event.target.value)}
                      onFocus={() => rememberVoiceTarget("newPlaceAddress")}
                      placeholder="3700 Walnut St or 39.95, -75.19"
                    />
                    <VoiceMic listening={voiceListening} active={voiceTarget === "newPlaceAddress"} onClick={() => toggleVoiceFor("newPlaceAddress")} />
                  </div>
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
                <div className="voice-field">
                  <input
                    value={customAddress}
                    onChange={(event) => setCustomAddress(event.target.value)}
                    onFocus={() => rememberVoiceTarget("customAddress")}
                    placeholder="Paste the location here"
                    autoFocus
                  />
                  <VoiceMic listening={voiceListening} active={voiceTarget === "customAddress"} onClick={() => toggleVoiceFor("customAddress")} />
                </div>
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

      {pendingCheckIn && checkInsEnabled && (
        <div className="item-editor-backdrop checkin-backdrop">
          <div className="item-editor checkin-prompt">
            <header>
              <div>
                <small>30-MINUTE CHECK-IN · {DEVICE_LABELS[pendingCheckIn.device]}</small>
                <h2>{formatSlotRange(pendingCheckIn.slotStart, pendingCheckIn.slotEnd)}</h2>
              </div>
            </header>
            <p>Tap what you were doing. No typing needed.</p>
            <div className="checkin-categories">
              {CHECK_IN_CATEGORIES.map((category) => (
                <button
                  key={category}
                  type="button"
                  className={`checkin-category-btn ${checkInDraft === category ? "active" : ""}`}
                  onClick={() => savePendingCheckIn(category, false)}
                >
                  {category}
                </button>
              ))}
            </div>
            <footer>
              <button type="button" className="secondary-action" onClick={() => snoozeCheckIn(5)}>
                Snooze 5 min
              </button>
              <button type="button" className="secondary-action" onClick={() => savePendingCheckIn("", true)}>
                Skip
              </button>
            </footer>
          </div>
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
                onFocus={() => rememberVoiceTarget("assistant")}
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
                <small>{voiceListening && voiceTarget === "assistant" ? "Listening… speak naturally" : "Enter to send · Shift+Enter for a new line"}</small>
                <span className="compose-actions">
                  <VoiceMic
                    listening={voiceListening}
                    active={voiceTarget === "assistant"}
                    onClick={() => toggleVoiceFor("assistant")}
                  />
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
