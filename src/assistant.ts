export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export type ScheduleEvent = {
  id: number;
  days: Weekday[];
  time: string;
  endTime?: string;
  title: string;
  location: string;
  address?: string;
  placeId?: number;
};

export type TaskDraft = {
  title: string;
  context: "Home" | "Campus" | "Anywhere";
  points: number;
};

export type HabitDraft = {
  title: string;
  icon: string;
};

export type AssistantResult = {
  reply: string;
  events: Omit<ScheduleEvent, "id">[];
  tasks: TaskDraft[];
  habits: HabitDraft[];
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

const DAY_ALIASES: Record<string, Weekday> = {
  m: "Monday",
  mon: "Monday",
  monday: "Monday",
  t: "Tuesday",
  tu: "Tuesday",
  tue: "Tuesday",
  tues: "Tuesday",
  tuesday: "Tuesday",
  w: "Wednesday",
  wed: "Wednesday",
  wednesday: "Wednesday",
  th: "Thursday",
  thu: "Thursday",
  thur: "Thursday",
  thurs: "Thursday",
  thursday: "Thursday",
  f: "Friday",
  fri: "Friday",
  friday: "Friday",
  sa: "Saturday",
  sat: "Saturday",
  saturday: "Saturday",
  su: "Sunday",
  sun: "Sunday",
  sunday: "Sunday",
};

const DAY_PATTERN =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thurs?|fri|sat|sun|M|T|W|Th|F|Sa|Su)\b/g;

const TIME_RANGE_PATTERN =
  /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/gi;

const SINGLE_TIME_PATTERN =
  /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i;

function capitalize(text: string) {
  return text
    .trim()
    .replace(/\b(upenn|llab|lern|skir|aud|gpu)\b/gi, (word) => word.toUpperCase())
    .replace(/(^|\s)\p{L}/gu, (match) => match.toUpperCase());
}

function normalizeTime(
  rawHour: string,
  rawMinute = "00",
  meridiem?: string,
  inheritedMeridiem?: string,
) {
  let hour = Number(rawHour);
  const minute = rawMinute.padStart(2, "0");
  const period = (meridiem || inheritedMeridiem || "").toLowerCase();

  if (period.startsWith("p") && hour < 12) hour += 12;
  if (period.startsWith("a") && hour === 12) hour = 0;

  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function extractDays(text: string): Weekday[] {
  const days: Weekday[] = [];
  const pattern = new RegExp(DAY_PATTERN.source, "gi");
  for (const match of text.matchAll(pattern)) {
    const day = DAY_ALIASES[match[1].toLowerCase()];
    if (day && !days.includes(day)) days.push(day);
  }
  return days;
}

function stripDays(text: string) {
  const pattern = new RegExp(DAY_PATTERN.source, "gi");
  return text
    .replace(pattern, " ")
    .replace(/\b(on|every)\b/gi, " ")
    .replace(/\s+\band\b\s*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function guessContext(text: string): TaskDraft["context"] {
  const lower = text.toLowerCase();
  if (/(home|apartment|dorm|evening|tonight)/.test(lower)) return "Home";
  if (/(campus|class|lecture|lab|library|grocery)/.test(lower)) return "Campus";
  return "Anywhere";
}

function guessHabitIcon(title: string) {
  const lower = title.toLowerCase();
  if (/read|book/.test(lower)) return "⌁";
  if (/workout|gym|run|exercise/.test(lower)) return "◇";
  if (/sleep|bed|early/.test(lower)) return "☾";
  if (/project|code|build/.test(lower)) return "↗";
  return "○";
}

function parseTitleAndLocation(prefix: string) {
  let cleaned = prefix
    .replace(/^\s*(?:i have|i've got|add|schedule|put|please)\s+/i, "")
    .replace(/\b(?:on|every)\s*$/i, "")
    .trim();

  cleaned = stripDays(cleaned).replace(/\s+at\s*$/i, "").trim();

  const locationMatch = cleaned.match(/\s+(?:in|at)\s+(.+)$/i);
  if (!locationMatch) {
    return {
      title: capitalize(cleaned.replace(/\b(class|lecture)\s*$/i, "").trim() || "Scheduled event"),
      location: "TBD",
    };
  }

  const location = capitalize(locationMatch[1]);
  const title = capitalize(
    cleaned
      .slice(0, locationMatch.index)
      .replace(/\b(class|lecture)\s*$/i, "")
      .trim() || "Scheduled event",
  );
  return { title, location };
}

function splitScheduleEntries(text: string) {
  return text
    .replace(/\s*(?:\.?\s*add (?:these|them|this).*)$/i, "")
    .split(/[,;\n]+|\s+and\s+(?=[A-Z]{2,}\b)/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseRecurringEntry(entry: string): Omit<ScheduleEvent, "id">[] {
  const matches = [...entry.matchAll(TIME_RANGE_PATTERN)];
  if (!matches.length) return [];

  const firstTimeIndex = matches[0].index ?? 0;
  const prefix = entry.slice(0, firstTimeIndex);
  const details = parseTitleAndLocation(prefix);
  const events: Omit<ScheduleEvent, "id">[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const matchIndex = match.index ?? 0;
    const previousEnd = index === 0
      ? 0
      : (matches[index - 1].index ?? 0) + matches[index - 1][0].length;
    const nextStart = index + 1 < matches.length
      ? (matches[index + 1].index ?? entry.length)
      : entry.length;

    const before = entry.slice(previousEnd, matchIndex);
    const after = entry.slice(matchIndex + match[0].length, nextStart);
    const beforeDays = extractDays(before);
    const days = beforeDays.length ? beforeDays : extractDays(after);
    const endPeriod = match[6];
    const startPeriod = match[3] || endPeriod;
    const location = details.location === "TBD"
      ? locationAfterTime(entry, match)
      : details.location;

    events.push({
      days: days.length ? days : [WEEKDAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1]],
      time: normalizeTime(match[1], match[2], match[3], startPeriod),
      endTime: normalizeTime(match[4], match[5], match[6], startPeriod),
      title: details.title,
      location,
    });
  }

  return events;
}

function locationAfterTime(entry: string, timeMatch: RegExpMatchArray) {
  const remainder = entry.slice((timeMatch.index ?? 0) + timeMatch[0].length);
  const match = remainder.match(/\s+(?:in|at)\s+(.+?)(?=$|[,.])/i);
  return match ? capitalize(stripDays(match[1])) : "TBD";
}

function parseSingleEntry(entry: string): Omit<ScheduleEvent, "id">[] {
  const match = entry.match(SINGLE_TIME_PATTERN);
  if (!match) return [];

  const prefix = entry.slice(0, match.index ?? 0);
  const parsed = parseTitleAndLocation(prefix);
  const location = parsed.location === "TBD" ? locationAfterTime(entry, match) : parsed.location;
  const days = extractDays(entry);

  return [{
    days: days.length ? days : [WEEKDAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1]],
    time: normalizeTime(match[1], match[2], match[3]),
    title: parsed.title,
    location,
  }];
}

function parseEvents(text: string): Omit<ScheduleEvent, "id">[] {
  return splitScheduleEntries(text).flatMap((entry) => {
    const recurring = parseRecurringEntry(entry);
    return recurring.length ? recurring : parseSingleEntry(entry);
  });
}

function parseActionItems(text: string) {
  const tasks: TaskDraft[] = [];
  const habits: HabitDraft[] = [];
  const hasTaskIntent =
    /\b(tasks?|to-?\s*dos?|things (?:that )?we need to do|remind me|don't forget|i need to)\b/i.test(text);
  const hasHabitIntent = /\bhabits?|track(?: me)?\b/i.test(text);

  if (!hasTaskIntent && !hasHabitIntent) return { tasks, habits };

  const normalized = text
    .replace(/[;\n]+/g, "|")
    .replace(/\b(first|1st|second|2nd|third|3rd|1\/3|fourth|4th|fifth|5th)\b/gi, "|")
    .replace(/\b(?:and\s+)?then\b[?.:,]*/gi, "|")
    .replace(/\b(?:the\s+)?next(?:\s+one)?(?:\s+is)?\b[?.:,]*/gi, "|")
    .replace(/\balso\b[?.:,]*/gi, "|")
    .replace(/[.!?]+\s+/g, "|");

  let mode: "task" | "habit" = hasTaskIntent ? "task" : "habit";
  let previousWasTaskCue = false;
  const actionPattern =
    /\b(look for|submit|apply|solve|continue|finish|complete|check|read|review|email|send|call|buy|pick up|work on|study|book|make|write|fix|pay|visit|return|clean|prepare|practice)\b/i;

  for (const rawClause of normalized.split("|")) {
    let clause = rawClause.replace(/\s+/g, " ").trim();
    if (!clause) continue;

    const switchesToTask =
      /\b(back (?:at|to|into) (?:the )?to-?\s*do|into (?:a )?to-?\s*do)\b/i.test(clause);
    const switchesToHabit = /\b(?:goes? )?into (?:the )?habits?\b/i.test(clause);
    const explicitHabit = /\b(?:add|create|track)(?: a)? habit\b/i.test(clause);
    const explicitTask =
      /\b(?:add|create)(?: (?:a|some))? tasks?\b|\bremind me to\b|\bdon't forget to\b|\bi need to\b/i.test(clause);

    if (switchesToTask || explicitTask) mode = "task";
    if (switchesToHabit || explicitHabit) mode = "habit";

    const hadModeSwitch = switchesToTask || switchesToHabit || explicitHabit || explicitTask;
    clause = clause
      .replace(/^.*?\bback (?:at|to|into) (?:the )?to-?\s*do\b[,:]*/i, "")
      .replace(/^.*?\binto (?:a )?to-?\s*do\b[,:]*/i, "")
      .replace(/^.*?\binto (?:the )?habits?\b[,:]*/i, "")
      .replace(/^.*?\b(?:add|create|track)(?: a)? habit(?: for| to)?\b[,:.]*/i, "")
      .replace(/^.*?\b(?:remind me to|don't forget to|i need to)\b[,:.]*/i, "")
      .replace(/^.*?\b(?:add|create)(?: (?:a|some))? tasks?(?: for| to)?\b[,:.]*/i, "")
      .replace(/^(?:ok(?:ay)?|so|let'?s|for example|this is|it'?s)\b[,:]*/i, "")
      .replace(/\s+/g, " ")
      .replace(/^[,.:;\s]+|[,.:;\s]+$/g, "")
      .trim();

    const actionMatch = clause.match(actionPattern);
    if (actionMatch?.index !== undefined) {
      clause = clause.slice(actionMatch.index);
    } else if (/^for\s+/i.test(clause) && (previousWasTaskCue || mode === "task")) {
      clause = `Find ${clause.replace(/^for\s+/i, "")}`;
    } else if (!hadModeSwitch || !clause) {
      previousWasTaskCue = explicitTask;
      continue;
    }

    clause = clause
      .replace(/^(?:i|we)\s+(?=(?:look|submit|apply|solve|continue|finish|check|read|review|email|send|call|buy|work|study|book|make|write|fix|pay|visit|return|clean|prepare|practice))/i, "")
      .replace(/\s+/g, " ")
      .trim();

    if (clause.length < 3 || /\b(?:things? we need|write down things)\b/i.test(clause)) {
      previousWasTaskCue = explicitTask;
      continue;
    }

    const title = capitalize(clause);
    if (mode === "habit") {
      if (!habits.some((habit) => habit.title.toLowerCase() === title.toLowerCase())) {
        habits.push({ title, icon: guessHabitIcon(title) });
      }
    } else if (!tasks.some((task) => task.title.toLowerCase() === title.toLowerCase())) {
      tasks.push({
        title,
        context: guessContext(title),
        points: /\b(project|study|essay|portfolio|internship)\b/i.test(title) ? 25 : 10,
      });
    }

    previousWasTaskCue = explicitTask;
  }

  return { tasks, habits };
}

export function processAssistantMessage(text: string): AssistantResult {
  const cleaned = text.trim();
  if (!cleaned) {
    return {
      reply: "Tell me a class, time, and place — for example: “Calculus Monday and Wednesday, 10–11am in Science Hall.”",
      events: [],
      tasks: [],
      habits: [],
    };
  }

  if (/^(hi|hello|hey|jarvis)\b/i.test(cleaned)) {
    return {
      reply: "Here. Paste your whole weekly class schedule and I’ll organize the days, times, and rooms.",
      events: [],
      tasks: [],
      habits: [],
    };
  }

  if (/help|what can you|how do/i.test(cleaned)) {
    return {
      reply: "I can add recurring classes, one-time events, tasks, and habits. Include each class name, location, weekdays, and start/end time.",
      events: [],
      tasks: [],
      habits: [],
    };
  }

  const events = parseEvents(cleaned);
  const { tasks, habits } = parseActionItems(cleaned);

  if (!events.length && !tasks.length && !habits.length) {
    const actionIntent = /\b(tasks?|to-?\s*dos?|habits?|remind me|need to do)\b/i.test(cleaned);
    return {
      reply: actionIntent
        ? "I couldn’t separate the items. Try: “Add tasks: submit the request; email Sam; read Arzani’s email.”"
        : "I couldn’t identify a complete event. Include a name and time, such as “Physics in DRL 2N36 Tuesday and Thursday 2–3:30pm.”",
      events: [],
      tasks: [],
      habits: [],
    };
  }

  const parts: string[] = [];
  if (events.length) {
    const classCount = new Set(events.map((event) => event.title)).size;
    parts.push(`Added ${events.length} schedule block${events.length === 1 ? "" : "s"} across ${classCount} event${classCount === 1 ? "" : "s"}.`);
  }
  if (tasks.length === 1) parts.push(`Added task: ${tasks[0].title}.`);
  if (tasks.length > 1) parts.push(`Added ${tasks.length} tasks: ${tasks.map((task) => task.title).join(", ")}.`);
  if (habits.length === 1) parts.push(`Tracking habit: ${habits[0].title}.`);
  if (habits.length > 1) parts.push(`Tracking ${habits.length} habits.`);

  return { reply: parts.join(" "), events, tasks, habits };
}
