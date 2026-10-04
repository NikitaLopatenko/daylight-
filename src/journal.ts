export const DAY_START_HOUR = 8;
const JOURNAL_KEY = "daylight-journal";
const PLANNER_DAY_KEY = "daylight-planner-day";

export type DayLog = {
  habits: string[];
  tasks: string[];
  /** HH:mm bedtime, usually the evening before this planner day. */
  sleepStart?: string;
  /** HH:mm wake time. */
  sleepEnd?: string;
  /** Duration in hours, kept for heatmaps and older logs. */
  sleepHours?: number;
  sleepAsked?: boolean;
};

export type Journal = Record<string, DayLog>;

export function emptyDay(): DayLog {
  return { habits: [], tasks: [] };
}

export function plannerDate(now = new Date()) {
  const shifted = new Date(now);
  if (shifted.getHours() < DAY_START_HOUR) {
    shifted.setDate(shifted.getDate() - 1);
  }
  shifted.setHours(12, 0, 0, 0);
  return shifted;
}

export function plannerDayKey(now = new Date()) {
  const day = plannerDate(now);
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `${day.getFullYear()}-${month}-${date}`;
}

export function readJournal(): Journal {
  try {
    const value = localStorage.getItem(JOURNAL_KEY);
    return value ? (JSON.parse(value) as Journal) : {};
  } catch {
    return {};
  }
}

export function writeJournal(journal: Journal) {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
}

export function readLastPlannerDay() {
  return localStorage.getItem(PLANNER_DAY_KEY);
}

export function writeLastPlannerDay(dayKey: string) {
  localStorage.setItem(PLANNER_DAY_KEY, dayKey);
}

export function updateDay(dayKey: string, patch: Partial<DayLog>) {
  const journal = readJournal();
  journal[dayKey] = { ...emptyDay(), ...journal[dayKey], ...patch };
  writeJournal(journal);
  return journal;
}

export function formatDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(year, month - 1, day, 12));
}

export type HeatCell = {
  key: string;
  count: number;
  future: boolean;
};

export type HeatWeek = HeatCell[];

export function timeToMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function minutesToClock(totalMinutes: number) {
  const normalized = ((Math.round(totalMinutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Noon→noon timeline percent for a clock time. */
export function sleepTimelinePercent(time: string) {
  return ((timeToMinutes(time) - 12 * 60 + 24 * 60) % (24 * 60)) / (24 * 60) * 100;
}

/** Convert a noon→noon timeline percent back to HH:mm, snapped to 5 minutes. */
export function sleepTimelineTime(percent: number, snapMinutes = 5) {
  const clamped = Math.min(100, Math.max(0, percent));
  const minutesFromNoon = (clamped / 100) * 24 * 60;
  const snapped = Math.round(minutesFromNoon / snapMinutes) * snapMinutes;
  return minutesToClock(snapped + 12 * 60);
}

export function sleepDurationHours(start: string, end: string) {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  const minutes = endMinutes >= startMinutes
    ? endMinutes - startMinutes
    : 24 * 60 - startMinutes + endMinutes;
  return Math.round((minutes / 60) * 10) / 10;
}

export function formatClock(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2000, 0, 1, hour, minute));
}

export function describeSleep(log?: DayLog) {
  if (!log) return "Sleep not logged";
  if (log.sleepStart && log.sleepEnd) {
    const hours = log.sleepHours ?? sleepDurationHours(log.sleepStart, log.sleepEnd);
    return `${formatClock(log.sleepStart)} → ${formatClock(log.sleepEnd)} · ${hours}h`;
  }
  if (log.sleepHours) return `${log.sleepHours} hours of sleep`;
  return "Sleep not logged";
}

/** Positions for a sleep window on a noon→noon timeline. */
export function sleepWindowSegments(start: string, end: string) {
  const startPos = sleepTimelinePercent(start);
  const endPos = sleepTimelinePercent(end);
  if (endPos >= startPos) {
    return [{ left: startPos, width: Math.max(endPos - startPos, 0.8) }];
  }
  return [
    { left: startPos, width: 100 - startPos },
    { left: 0, width: Math.max(endPos, 0.8) },
  ];
}

export function buildHeatmap(journal: Journal, kind: "habits" | "sleep", today = new Date(), weeks = 26): HeatWeek[] {
  const end = plannerDate(today);
  const start = new Date(end);
  start.setDate(end.getDate() - end.getDay() - (weeks - 1) * 7);

  const columns: HeatWeek[] = [];
  for (let week = 0; week < weeks; week += 1) {
    const cells: HeatCell[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7 + weekday);
      const key = plannerDayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12));
      const log = journal[key];
      const sleepHours = log?.sleepHours
        ?? (log?.sleepStart && log?.sleepEnd ? sleepDurationHours(log.sleepStart, log.sleepEnd) : 0);
      const count = kind === "habits" ? (log?.habits.length ?? 0) : sleepHours;
      cells.push({
        key,
        count,
        future: date.getTime() > end.getTime(),
      });
    }
    columns.push(cells);
  }
  return columns;
}

export function habitLevel(count: number) {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 4;
}

export function sleepLevel(hours: number) {
  if (hours <= 0) return 0;
  if (hours < 6) return 1;
  if (hours < 7) return 2;
  if (hours <= 9) return 3;
  return 4;
}
