import { plannerDayKey } from "../journal";

export type DeviceKind = "phone" | "laptop" | "imac";

export type TimeCheckIn = {
  id: string;
  dayKey: string;
  /** Slot start ISO */
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

export function slotId(start: Date, device: DeviceKind | "free" = "free") {
  const base = `${plannerDayKey(start)}-${String(start.getHours()).padStart(2, "0")}${String(start.getMinutes()).padStart(2, "0")}`;
  return `${base}-${device}`;
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
  const day = [...(log[entry.dayKey] ?? []).filter((item) => item.id !== entry.id), entry]
    .sort((a, b) => a.slotStart.localeCompare(b.slotStart) || a.device.localeCompare(b.device));
  return { ...log, [entry.dayKey]: day };
}

export function entriesForSlot(log: CheckInLog, dayKey: string, slotStartIso: string) {
  return (log[dayKey] ?? []).filter((item) => item.slotStart === slotStartIso);
}

/** Prompt only for THIS device's most recent unanswered completed slot (not old catch-up spam). */
export function pendingCheckInSlot(log: CheckInLog, device: DeviceKind, now = new Date()) {
  const { start, end } = previousCompletedSlot(now);
  if (now.getTime() - end.getTime() < 60_000) return null;

  const id = slotId(start, device);
  const dayKey = plannerDayKey(start);
  const existing = (log[dayKey] ?? []).find((item) => item.id === id);
  if (existing) return null;

  // If this slot is already marked screen-free globally, no device prompt.
  const free = (log[dayKey] ?? []).find((item) => item.slotStart === start.toISOString() && item.inferred);
  if (free) return null;

  return {
    id,
    dayKey,
    slotStart: start.toISOString(),
    slotEnd: end.toISOString(),
    device,
  };
}

/**
 * Fill completed slots since lastAnyActive with inferred screen-free rows
 * when no device logged anything for that slot.
 */
export function fillScreenFreeGaps(log: CheckInLog, lastActiveMs: number, now = new Date()): CheckInLog {
  // Need a prior session marker; otherwise we'd invent a fake empty day on first launch.
  if (!lastActiveMs || lastActiveMs <= 0) return log;

  const { end: latestEnd } = previousCompletedSlot(now);

  let cursorEnd = latestEnd;
  // Cap lookback at 18h even if an old heartbeat exists.
  const floorMs = Math.max(lastActiveMs, now.getTime() - 18 * 60 * 60 * 1000);

  let next = log;
  let guard = 0;
  while (cursorEnd.getTime() - SLOT_MS >= floorMs && guard < 40) {
    guard += 1;
    const end = cursorEnd;
    const start = new Date(end.getTime() - SLOT_MS);
    // Only auto-fill slots that ended after we last saw any device
    if (end.getTime() <= floorMs) break;

    const dayKey = plannerDayKey(start);
    const slotStart = start.toISOString();
    const existing = entriesForSlot(next, dayKey, slotStart);
    if (existing.length === 0) {
      const entry: TimeCheckIn = {
        id: slotId(start, "free"),
        dayKey,
        slotStart,
        slotEnd: end.toISOString(),
        note: "Screen-free",
        createdAt: Date.now(),
        device: "phone", // unused when inferred; display uses inferred flag
        inferred: true,
      };
      next = upsertCheckIn(next, entry);
    }
    cursorEnd = start;
  }
  return next;
}

export type SlotRow = {
  slotStart: string;
  slotEnd: string;
  label: string;
  byDevice: Partial<Record<DeviceKind, TimeCheckIn>>;
  screenFree?: TimeCheckIn;
};

export function buildDaySlotRows(log: CheckInLog, dayKey: string, now = new Date()): SlotRow[] {
  const entries = dayCheckIns(log, dayKey);
  const starts = new Set<string>();
  for (const entry of entries) starts.add(entry.slotStart);

  // Always include completed slots from day start (planner day 8am) through previous slot
  const [y, m, d] = dayKey.split("-").map(Number);
  let cursor = new Date(y, m - 1, d, 8, 0, 0, 0);
  const { end: latestEnd } = previousCompletedSlot(now);
  const dayEndCap = plannerDayKey(latestEnd) === dayKey ? latestEnd : new Date(y, m - 1, d + 1, 8, 0, 0, 0);

  while (cursor < dayEndCap) {
    starts.add(cursor.toISOString());
    cursor = new Date(cursor.getTime() + SLOT_MS);
  }

  return [...starts]
    .sort()
    .map((slotStart) => {
      const list = entriesForSlot(log, dayKey, slotStart);
      const screenFree = list.find((item) => item.inferred);
      const byDevice: Partial<Record<DeviceKind, TimeCheckIn>> = {};
      for (const item of list) {
        if (item.inferred) continue;
        byDevice[item.device] = item;
      }
      const slotEnd = list[0]?.slotEnd
        ?? new Date(new Date(slotStart).getTime() + SLOT_MS).toISOString();
      return {
        slotStart,
        slotEnd,
        label: formatSlotRange(slotStart, slotEnd),
        byDevice,
        screenFree,
      };
    })
    .filter((row) => {
      // hide future empty trailing rows beyond "now" unless they have data
      if (new Date(row.slotEnd).getTime() > now.getTime() + 60_000) {
        return Boolean(row.screenFree || DEVICES.some((device) => row.byDevice[device]));
      }
      return true;
    });
}

export function dayCheckIns(log: CheckInLog, dayKey: string) {
  return [...(log[dayKey] ?? [])].sort((a, b) => a.slotStart.localeCompare(b.slotStart));
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
        return {
          id: String(item.id),
          dayKey: String(item.dayKey ?? day),
          slotStart: String(item.slotStart ?? ""),
          slotEnd: String(item.slotEnd ?? ""),
          note: String(item.note ?? ""),
          createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
          skipped: Boolean(item.skipped),
          inferred: Boolean((item as TimeCheckIn).inferred),
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
