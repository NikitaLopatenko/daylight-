import { plannerDayKey } from "../journal";

export type TimeCheckIn = {
  id: string;
  dayKey: string;
  /** Slot start ISO */
  slotStart: string;
  /** Slot end ISO */
  slotEnd: string;
  note: string;
  createdAt: number;
  skipped?: boolean;
};

export type CheckInLog = Record<string, TimeCheckIn[]>;

const STORAGE_KEY = "daylight-checkins";
const ENABLED_KEY = "daylight-checkins-enabled";
const SNOOZE_KEY = "daylight-checkins-snooze-until";
export const SLOT_MS = 30 * 60 * 1000;

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

export function readCheckIns(): CheckInLog {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CheckInLog;
    return parsed && typeof parsed === "object" ? parsed : {};
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

export function slotId(start: Date) {
  return `${plannerDayKey(start)}-${String(start.getHours()).padStart(2, "0")}${String(start.getMinutes()).padStart(2, "0")}`;
}

export function formatSlotRange(startIso: string, endIso: string) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

export function upsertCheckIn(log: CheckInLog, entry: TimeCheckIn): CheckInLog {
  const day = [...(log[entry.dayKey] ?? []).filter((item) => item.id !== entry.id), entry]
    .sort((a, b) => a.slotStart.localeCompare(b.slotStart));
  return { ...log, [entry.dayKey]: day };
}

export function findCheckIn(log: CheckInLog, id: string) {
  for (const day of Object.values(log)) {
    const hit = day.find((item) => item.id === id);
    if (hit) return hit;
  }
  return null;
}

/** Oldest unanswered completed slot in the last ~8 hours (catch up one at a time). */
export function pendingCheckInSlot(log: CheckInLog, now = new Date()) {
  const { end: latestEnd } = previousCompletedSlot(now);
  // Wait a minute into the new slot so we don't fire on the exact boundary flicker.
  if (now.getTime() - latestEnd.getTime() < 60_000) return null;

  const maxLookback = 16; // 8 hours
  for (let i = maxLookback - 1; i >= 0; i -= 1) {
    const end = new Date(latestEnd.getTime() - i * SLOT_MS);
    const start = new Date(end.getTime() - SLOT_MS);
    const id = slotId(start);
    const dayKey = plannerDayKey(start);
    const existing = (log[dayKey] ?? []).find((item) => item.id === id);
    if (!existing) {
      return {
        id,
        dayKey,
        slotStart: start.toISOString(),
        slotEnd: end.toISOString(),
      };
    }
  }
  return null;
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
      .map((item) => ({
        id: String(item.id),
        dayKey: String(item.dayKey ?? day),
        slotStart: String(item.slotStart ?? ""),
        slotEnd: String(item.slotEnd ?? ""),
        note: String(item.note ?? ""),
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        skipped: Boolean(item.skipped),
      }))
      .filter((item) => item.slotStart && item.slotEnd);
  }
  return out;
}
