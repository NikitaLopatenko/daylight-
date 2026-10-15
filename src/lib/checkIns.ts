import { plannerDayKey } from "../journal";

export type DeviceKind = "phone" | "laptop" | "imac";

export type TimeCheckIn = {
  id: string;
  dayKey: string;
  /** Local slot key: YYYY-MM-DDTHH:mm */
  slotKey: string;
  /** Slot start ISO (display / legacy) */
  slotStart: string;
  /** Slot end ISO */
  slotEnd: string;
  note: string;
  createdAt: number;
  device: DeviceKind;
  skipped?: boolean;
  /** Auto-filled because no device had Daylight open / logged */
  inferred?: boolean;
};

export type CheckInLog = Record<string, TimeCheckIn[]>;
export type DeviceHeartbeats = Partial<Record<DeviceKind, number>>;

const STORAGE_KEY = "daylight-checkins";
const ENABLED_KEY = "daylight-checkins-enabled";
const SNOOZE_KEY = "daylight-checkins-snooze-until";
const DEVICE_KEY = "daylight-device-kind";
const HEARTBEATS_KEY = "daylight-device-heartbeats";
export const SLOT_MS = 30 * 60 * 1000;
export const DEVICES: DeviceKind[] = ["phone", "laptop", "imac"];
export const DEVICE_LABELS: Record<DeviceKind, string> = {
  phone: "Phone",
  laptop: "Laptop",
  imac: "iMac",
};

/** Tap options instead of typing. */
export const CHECK_IN_CATEGORIES = [
  "Homework / class",
  "Research / coding",
  "Social media",
  "Gym / sports",
  "Table tennis",
  "Meals",
  "Commute / walking",
  "Entertainment",
  "Chores / errands",
  "Sleep / rest",
  "Friends / social",
  "Other",
] as const;

export type CheckInCategory = (typeof CHECK_IN_CATEGORIES)[number];

export function readCheckInsEnabled() {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    if (raw === null) return true;
    return raw === "1" || raw === "true";
  } catch {
    return true;
  }
}

export function writeCheckInsEnabled(enabled: boolean) {
  localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
}

export function readSnoozeUntil() {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

export function writeSnoozeUntil(ms: number) {
  localStorage.setItem(SNOOZE_KEY, String(ms));
}

export function detectDefaultDevice(): DeviceKind {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|Android/i.test(ua)) return "phone";
  if (/Macintosh|Mac OS X/i.test(ua)) return "imac";
  return "laptop";
}

export function readDeviceKind(): DeviceKind {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (raw === "phone" || raw === "laptop" || raw === "imac") return raw;
  } catch {
    // ignore
  }
  const detected = detectDefaultDevice();
  writeDeviceKind(detected);
  return detected;
}

export function writeDeviceKind(device: DeviceKind) {
  localStorage.setItem(DEVICE_KEY, device);
}

export function readLocalHeartbeats(): DeviceHeartbeats {
  try {
    const raw = localStorage.getItem(HEARTBEATS_KEY);
    return raw ? JSON.parse(raw) as DeviceHeartbeats : {};
  } catch {
    return {};
  }
}

export function writeLocalHeartbeats(beats: DeviceHeartbeats) {
  localStorage.setItem(HEARTBEATS_KEY, JSON.stringify(beats));
}

export function mergeHeartbeats(a: DeviceHeartbeats = {}, b: DeviceHeartbeats = {}): DeviceHeartbeats {
  const out: DeviceHeartbeats = { ...a };
  for (const device of DEVICES) {
    out[device] = Math.max(a[device] ?? 0, b[device] ?? 0);
  }
  return out;
}

export function touchHeartbeat(beats: DeviceHeartbeats, device: DeviceKind, at = Date.now()): DeviceHeartbeats {
  return { ...beats, [device]: at };
}

export function lastAnyDeviceActive(beats: DeviceHeartbeats) {
  return Math.max(0, ...DEVICES.map((device) => beats[device] ?? 0));
}

export function readCheckIns(): CheckInLog {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CheckInLog;
    return parsed && typeof parsed === "object" ? normalizeCheckInLog(parsed) : {};
  } catch {
    return {};
  }
}

export function writeCheckIns(log: CheckInLog) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export function floorToSlot(date: Date) {
  const d = new Date(date);
  const minutes = d.getMinutes() < 30 ? 0 : 30;
  d.setMinutes(minutes, 0, 0);
  d.setMilliseconds(0);
  return d;
}

export function previousCompletedSlot(now = new Date()) {
  const currentStart = floorToSlot(now);
  const end = currentStart;
  const start = new Date(end.getTime() - SLOT_MS);
  return { start, end };
}

/** Stable local key so phone / Windows / Mac match the same half-hour. */
export function slotKeyFromDate(start: Date) {
  return `${plannerDayKey(start)}T${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
}

export function slotId(slotKey: string, device: DeviceKind | "free" = "free") {
  return `${slotKey}-${device}`;
}

export function formatSlotRange(startIso: string, endIso: string) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

export function formatClock(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function upsertCheckIn(log: CheckInLog, entry: TimeCheckIn): CheckInLog {
  const dayList = [...(log[entry.dayKey] ?? [])];
  // Real device log replaces inferred screen-free for that slot.
  const filtered = dayList.filter((item) => {
    if (item.id === entry.id) return false;
    if (!entry.inferred && item.inferred && item.slotKey === entry.slotKey) return false;
    return true;
  });
  const day = [...filtered, entry]
    .sort((a, b) => a.slotKey.localeCompare(b.slotKey) || a.device.localeCompare(b.device));
  return { ...log, [entry.dayKey]: day };
}

/** Merge two logs by entry id (newer createdAt wins). Critical for multi-device sync. */
export function mergeCheckInLogs(a: CheckInLog = {}, b: CheckInLog = {}): CheckInLog {
  const out: CheckInLog = {};
  const days = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const day of days) {
    const map = new Map<string, TimeCheckIn>();
    for (const entry of [...(a[day] ?? []), ...(b[day] ?? [])]) {
      const prev = map.get(entry.id);
      if (!prev || entry.createdAt >= prev.createdAt) map.set(entry.id, entry);
    }
    out[day] = [...map.values()].sort(
      (x, y) => x.slotKey.localeCompare(y.slotKey) || x.device.localeCompare(y.device),
    );
  }
  return out;
}

export function entriesForSlotKey(log: CheckInLog, dayKey: string, slotKey: string) {
  return (log[dayKey] ?? []).filter((item) => item.slotKey === slotKey);
}

/** Prompt for THIS device's previous completed half-hour if not logged yet. */
export function pendingCheckInSlot(log: CheckInLog, device: DeviceKind, now = new Date()) {
  const { start, end } = previousCompletedSlot(now);
  // Small settle window so we don't fire on the exact boundary.
  if (now.getTime() - end.getTime() < 15_000) return null;

  const key = slotKeyFromDate(start);
  const id = slotId(key, device);
  const dayKey = plannerDayKey(start);
  const existing = (log[dayKey] ?? []).find((item) => item.id === id);
  if (existing && !existing.inferred) return null;

  return {
    id,
    dayKey,
    slotKey: key,
    slotStart: start.toISOString(),
    slotEnd: end.toISOString(),
    device,
  };
}

/**
 * Fill older completed slots since lastAnyActive with inferred screen-free rows
 * when no device logged anything for that slot. Skips the newest slot so the
 * current device can still answer the prompt.
 */
export function fillScreenFreeGaps(log: CheckInLog, lastActiveMs: number, now = new Date()): CheckInLog {
  if (!lastActiveMs || lastActiveMs <= 0) return log;

  const { end: latestEnd } = previousCompletedSlot(now);
  let cursorEnd = new Date(latestEnd.getTime() - SLOT_MS); // skip newest completed slot
  const floorMs = Math.max(lastActiveMs, now.getTime() - 18 * 60 * 60 * 1000);

  let next = log;
  let guard = 0;
  while (cursorEnd.getTime() - SLOT_MS >= floorMs && guard < 40) {
    guard += 1;
    const end = cursorEnd;
    const start = new Date(end.getTime() - SLOT_MS);
    if (end.getTime() <= floorMs) break;

    const dayKey = plannerDayKey(start);
    const key = slotKeyFromDate(start);
    const existing = entriesForSlotKey(next, dayKey, key);
    if (existing.length === 0) {
      const entry: TimeCheckIn = {
        id: slotId(key, "free"),
        dayKey,
        slotKey: key,
        slotStart: start.toISOString(),
        slotEnd: end.toISOString(),
        note: "Screen-free",
        createdAt: Date.now(),
        device: "phone",
        inferred: true,
      };
      next = upsertCheckIn(next, entry);
    }
    cursorEnd = start;
  }
  return next;
}

export type SlotRow = {
  slotKey: string;
  slotStart: string;
  slotEnd: string;
  label: string;
  byDevice: Partial<Record<DeviceKind, TimeCheckIn>>;
  screenFree?: TimeCheckIn;
};

export function buildDaySlotRows(log: CheckInLog, dayKey: string, now = new Date()): SlotRow[] {
  const entries = dayCheckIns(log, dayKey);
  const keys = new Set<string>();
  for (const entry of entries) keys.add(entry.slotKey);

  const [y, m, d] = dayKey.split("-").map(Number);
  let cursor = new Date(y, m - 1, d, 8, 0, 0, 0);
  const { end: latestEnd } = previousCompletedSlot(now);
  const dayEndCap = plannerDayKey(latestEnd) === dayKey
    ? latestEnd
    : new Date(y, m - 1, d + 1, 8, 0, 0, 0);

  while (cursor < dayEndCap) {
    keys.add(slotKeyFromDate(cursor));
    cursor = new Date(cursor.getTime() + SLOT_MS);
  }

  return [...keys]
    .sort()
    .map((key) => {
      const list = entriesForSlotKey(log, dayKey, key);
      const screenFree = list.find((item) => item.inferred);
      const byDevice: Partial<Record<DeviceKind, TimeCheckIn>> = {};
      for (const item of list) {
        if (item.inferred) continue;
        byDevice[item.device] = item;
      }
      const start = list[0]
        ? new Date(list[0].slotStart)
        : (() => {
          const [datePart, timePart] = key.split("T");
          const [yy, mm, dd] = datePart.split("-").map(Number);
          const [hh, mi] = timePart.split(":").map(Number);
          return new Date(yy, mm - 1, dd, hh, mi, 0, 0);
        })();
      const end = list[0] ? new Date(list[0].slotEnd) : new Date(start.getTime() + SLOT_MS);
      return {
        slotKey: key,
        slotStart: start.toISOString(),
        slotEnd: end.toISOString(),
        label: formatSlotRange(start.toISOString(), end.toISOString()),
        byDevice,
        screenFree,
      };
    })
    .filter((row) => {
      if (new Date(row.slotEnd).getTime() > now.getTime() + 60_000) {
        return Boolean(row.screenFree || DEVICES.some((device) => row.byDevice[device]));
      }
      return true;
    });
}

export function dayCheckIns(log: CheckInLog, dayKey: string) {
  return [...(log[dayKey] ?? [])].sort((a, b) => a.slotKey.localeCompare(b.slotKey));
}

function legacySlotKey(slotStartIso: string, dayKey: string) {
  try {
    const start = new Date(slotStartIso);
    if (!Number.isNaN(start.getTime())) return slotKeyFromDate(start);
  } catch {
    // ignore
  }
  return `${dayKey}T00:00`;
}

export function normalizeCheckInLog(raw: unknown): CheckInLog {
  if (!raw || typeof raw !== "object") return {};
  const out: CheckInLog = {};
  for (const [day, list] of Object.entries(raw as CheckInLog)) {
    if (!Array.isArray(list)) continue;
    out[day] = list
      .filter((item) => item && typeof item === "object" && typeof item.id === "string")
      .map((item) => {
        const deviceRaw = String((item as TimeCheckIn).device ?? "");
        const device: DeviceKind = deviceRaw === "phone" || deviceRaw === "laptop" || deviceRaw === "imac"
          ? deviceRaw
          : "laptop";
        const slotStart = String(item.slotStart ?? "");
        const slotKey = String((item as TimeCheckIn).slotKey || legacySlotKey(slotStart, day));
        const inferred = Boolean((item as TimeCheckIn).inferred);
        // Canonical ids so phone / Windows / iMac merge the same row.
        const id = inferred ? slotId(slotKey, "free") : slotId(slotKey, device);
        return {
          id,
          dayKey: String(item.dayKey ?? day),
          slotKey,
          slotStart,
          slotEnd: String(item.slotEnd ?? ""),
          note: String(item.note ?? ""),
          createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
          skipped: Boolean(item.skipped),
          inferred,
          device,
        };
      })
      .filter((item) => item.slotStart && item.slotEnd);
  }
  return out;
}

export function normalizeHeartbeats(raw: unknown): DeviceHeartbeats {
  if (!raw || typeof raw !== "object") return {};
  const out: DeviceHeartbeats = {};
  for (const device of DEVICES) {
    const value = (raw as DeviceHeartbeats)[device];
    if (typeof value === "number" && Number.isFinite(value)) out[device] = value;
  }
  return out;
}
