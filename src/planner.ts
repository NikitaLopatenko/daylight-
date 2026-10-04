import type { ScheduleEvent, Weekday } from "./assistant";

export type PlannerTask = {
  id: number;
  title: string;
  context: "Home" | "Campus" | "Anywhere";
  done: boolean;
  address?: string;
  placeId?: number;
};

export type PlaceRole = "Home" | "Gym" | "Dining" | "Campus" | "Other";

export type SavedPlace = {
  id: number;
  name: string;
  address: string;
  role: PlaceRole;
};

export type PlaceSettings = {
  city: string;
  places: SavedPlace[];
};

export type PlanItem = {
  id: string;
  start: number;
  end: number;
  title: string;
  location: string;
  kind: "event" | "task" | "travel" | "meal";
  reason: string;
};

export type SuggestedPlan = {
  generatedAt: string;
  items: PlanItem[];
  locationStatus: string;
};

type Coordinates = {
  latitude: number;
  longitude: number;
};

type Candidate = {
  id: number;
  title: string;
  duration: number;
  category: "home" | "admin" | "meal" | "workout" | "campus" | "other";
  location: string;
  locationQuery: string;
  coordinates?: Coordinates;
};

const geocodeCache = new Map<string, Coordinates | null>();

export function parseAddressInput(input: string) {
  const value = input.trim();
  let decoded = value;
  try {
    decoded = decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // Keep the original if a pasted URL contains malformed encoding.
  }

  const coordinatePatterns = [
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/,
  ];
  for (const pattern of coordinatePatterns) {
    const match = decoded.match(pattern);
    if (match) {
      return {
        query: `${match[1]}, ${match[2]}`,
        coordinates: { latitude: Number(match[1]), longitude: Number(match[2]) },
        format: "coordinates" as const,
      };
    }
  }

  if (/https?:\/\/(?:www\.)?(?:google\.[^/]+\/maps|maps\.google\.)/i.test(value)) {
    try {
      const url = new URL(value);
      const query = url.searchParams.get("q")
        ?? url.pathname.match(/\/place\/([^/]+)/i)?.[1]
        ?? "";
      if (query) {
        const readable = decodeURIComponent(query.replace(/\+/g, " "));
        return { query: readable, format: "google-maps" as const };
      }
    } catch {
      // The original text remains a valid geocoding query fallback.
    }
  }

  return { query: value, format: "address" as const };
}

export function minutesToTime(minutes: number) {
  const normalized = Math.max(0, Math.min(minutes, 24 * 60 - 1));
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2000, 0, 1, hour, minute));
}

function timeToMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function taskCategory(task: PlannerTask): Candidate["category"] {
  const title = task.title.toLowerCase();
  if (/\b(dining|eat|meal|lunch|dinner|food|cafeteria)\b/.test(title)) return "meal";
  if (/\b(workout|gym|exercise|run|lifting)\b/.test(title)) return "workout";
  if (task.context === "Home" || /\b(clean|laundry|room|home|dishes)\b/.test(title)) return "home";
  if (/\b(email|message|call|submit|apply|request|linkedin)\b/.test(title)) return "admin";
  if (task.context === "Campus") return "campus";
  return "other";
}

function taskDuration(title: string, category: Candidate["category"]) {
  const explicit = title.match(/\b(\d+)\s*(?:minutes?|mins?)\b/i);
  if (explicit) return Math.max(5, Number(explicit[1]));
  if (category === "meal") return 45;
  if (category === "workout") return 75;
  if (category === "home") return 35;
  if (category === "admin") return 15;
  if (/\b(project|study|read|review)\b/i.test(title)) return 60;
  return 30;
}

function normalizePlaceName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchingSavedPlace(label: string, placeId: number | undefined, settings: PlaceSettings) {
  if (placeId) {
    const direct = settings.places.find((place) => place.id === placeId);
    if (direct) return direct;
  }

  const normalizedLabel = normalizePlaceName(label);
  if (!normalizedLabel) return undefined;
  return settings.places.find((place) => {
    const normalizedName = normalizePlaceName(place.name);
    return normalizedName.length >= 3
      && (normalizedLabel.includes(normalizedName) || normalizedName.includes(normalizedLabel));
  });
}

function resolvedLocation(
  label: string,
  address: string | undefined,
  placeId: number | undefined,
  settings: PlaceSettings,
) {
  if (address) return { label: label || address, query: address };
  const saved = matchingSavedPlace(label, placeId, settings);
  if (saved) return { label: saved.name, query: saved.address };
  return { label, query: label };
}

function candidateLocation(
  task: PlannerTask,
  category: Candidate["category"],
  places: PlaceSettings,
  firstCampusLocation: { label: string; query: string },
) {
  const explicit = resolvedLocation("", task.address, task.placeId, places);
  if (explicit.query) return explicit;

  const role = category === "home"
    ? "Home"
    : category === "meal"
      ? "Dining"
      : category === "workout"
        ? "Gym"
        : undefined;
  if (role) {
    const saved = places.places.find((place) => place.role === role);
    if (saved) return { label: saved.name, query: saved.address };
  }

  if (category === "campus") return firstCampusLocation;
  // Admin and general tasks intentionally remain location-free: they can be
  // performed at home, between lectures, or anywhere else.
  return { label: "", query: "" };
}

async function geocode(location: string, city: string): Promise<Coordinates | null> {
  if (!location || location === "TBD") return null;
  const parsed = parseAddressInput(location);
  if (parsed.coordinates) return parsed.coordinates;
  const locationQuery = parsed.query;
  const cacheKey = `${locationQuery}|${city}`.toLowerCase();
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey) ?? null;

  try {
    const query = city && !locationQuery.toLowerCase().includes(city.toLowerCase())
      ? `${locationQuery}, ${city}`
      : locationQuery;
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "0");

    const response = await fetch(url, {
      headers: { "Accept-Language": "en-US,en" },
    });
    if (!response.ok) throw new Error("Geocoding failed");
    const results = await response.json() as Array<{ lat: string; lon: string }>;
    const coordinates = results[0]
      ? { latitude: Number(results[0].lat), longitude: Number(results[0].lon) }
      : null;
    geocodeCache.set(cacheKey, coordinates);
    return coordinates;
  } catch {
    geocodeCache.set(cacheKey, null);
    return null;
  }
}

function walkingMinutes(from?: Coordinates | null, to?: Coordinates | null) {
  if (!from || !to) return 0;
  const radiusKm = 6371;
  const latitudeDelta = (to.latitude - from.latitude) * Math.PI / 180;
  const longitudeDelta = (to.longitude - from.longitude) * Math.PI / 180;
  const firstLatitude = from.latitude * Math.PI / 180;
  const secondLatitude = to.latitude * Math.PI / 180;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const distanceKm = radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.max(0, Math.ceil((distanceKm / 4.8) * 60 / 5) * 5);
}

function preferenceScore(
  candidate: Candidate,
  windowIndex: number,
  cursor: number,
  currentCoordinates?: Coordinates | null,
) {
  let score = 0;
  if (windowIndex === 0 && (candidate.category === "admin" || candidate.category === "home")) score += 50;
  if (windowIndex > 0 && candidate.category === "campus") score += 35;
  if (candidate.category === "meal" && ((cursor >= 11 * 60 && cursor <= 14 * 60) || cursor >= 16 * 60)) score += 80;
  if (candidate.category === "workout" && windowIndex > 0) score += 18;
  const travel = walkingMinutes(currentCoordinates, candidate.coordinates);
  score -= travel;
  return score;
}

function addFlexibleItem(
  plan: PlanItem[],
  candidate: Candidate,
  cursor: number,
  fromCoordinates?: Coordinates | null,
) {
  const travel = walkingMinutes(fromCoordinates, candidate.coordinates);
  let nextCursor = cursor;

  if (travel >= 5) {
    plan.push({
      id: `travel-${candidate.id}-${cursor}`,
      start: nextCursor,
      end: nextCursor + travel,
      title: `Walk to ${candidate.location}`,
      location: candidate.location,
      kind: "travel",
      reason: `Estimated ${travel}-minute walk based on location distance.`,
    });
    nextCursor += travel;
  }

  plan.push({
    id: `task-${candidate.id}`,
    start: nextCursor,
    end: nextCursor + candidate.duration,
    title: candidate.title,
    location: candidate.location,
    kind: candidate.category === "meal" ? "meal" : "task",
    reason: candidate.category === "meal"
      ? "Placed in a meal window so you are not waiting until late evening to eat."
      : candidate.category === "home" || candidate.category === "admin"
        ? "Placed before leaving when it can be completed with little travel."
        : "Placed near the surrounding schedule to reduce backtracking.",
  });

  return { cursor: nextCursor + candidate.duration, coordinates: candidate.coordinates };
}

export async function buildSuggestedPlan(
  tasks: PlannerTask[],
  schedule: ScheduleEvent[],
  day: Weekday,
  places: PlaceSettings,
  now = new Date(),
): Promise<SuggestedPlan> {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const cursorStart = Math.ceil(nowMinutes / 5) * 5;
  const fixedEvents = schedule
    .filter((event) => event.days.includes(day))
    .map((event) => {
      const start = timeToMinutes(event.time);
      const resolved = resolvedLocation(event.location, event.address, event.placeId, places);
      return {
        ...event,
        location: resolved.label || event.location,
        locationQuery: resolved.query,
        start,
        end: event.endTime ? timeToMinutes(event.endTime) : start + 60,
      };
    })
    .filter((event) => event.end > cursorStart)
    .sort((first, second) => first.start - second.start);

  const firstCampusEvent = fixedEvents.find((event) => event.location !== "TBD");
  const firstCampusLocation = firstCampusEvent
    ? { label: firstCampusEvent.location, query: firstCampusEvent.locationQuery }
    : { label: "", query: "" };
  const candidates: Candidate[] = tasks
    .filter((task) => !task.done)
    .map((task) => {
      const category = taskCategory(task);
      const resolved = candidateLocation(task, category, places, firstCampusLocation);
      return {
        id: task.id,
        title: task.title,
        category,
        duration: taskDuration(task.title, category),
        location: resolved.label,
        locationQuery: resolved.query,
      };
    });

  const locations = [...new Set([
    ...fixedEvents.map((event) => event.locationQuery),
    ...candidates.map((candidate) => candidate.locationQuery),
    ...places.places.filter((place) => place.role === "Home").map((place) => place.address),
  ].filter((location) => location && location !== "TBD"))];
  const coordinateEntries = await Promise.all(
    locations.map(async (location) => [location, await geocode(location, places.city)] as const),
  );
  const coordinates = new Map(coordinateEntries);

  for (const candidate of candidates) {
    candidate.coordinates = coordinates.get(candidate.locationQuery) ?? undefined;
  }

  const plan: PlanItem[] = [];
  const remaining = [...candidates];
  let cursor = cursorStart;
  const home = places.places.find((place) => place.role === "Home");
  let currentCoordinates = home ? coordinates.get(home.address) : null;

  for (let eventIndex = 0; eventIndex < fixedEvents.length; eventIndex += 1) {
    const fixed = fixedEvents[eventIndex];
    const fixedCoordinates = coordinates.get(fixed.locationQuery);
    const hardStop = Math.max(cursor, fixed.start - walkingMinutes(currentCoordinates, fixedCoordinates));

    while (remaining.length) {
      const ranked = remaining
        .map((candidate) => ({
          candidate,
          score: preferenceScore(candidate, eventIndex, cursor, currentCoordinates),
          required: candidate.category === "workout"
            || (candidate.category === "meal" && cursor < 11 * 60)
            || (candidate.category === "meal" && eventIndex === 0 && fixed.end <= 14 * 60 + 30)
            ? Number.POSITIVE_INFINITY
            : walkingMinutes(currentCoordinates, candidate.coordinates)
            + candidate.duration
            + walkingMinutes(candidate.coordinates, fixedCoordinates),
        }))
        .filter((entry) => cursor + entry.required <= fixed.start)
        .sort((first, second) => second.score - first.score);
      if (!ranked.length || cursor >= hardStop) break;

      const selected = ranked[0].candidate;
      const added = addFlexibleItem(plan, selected, cursor, currentCoordinates);
      cursor = added.cursor;
      currentCoordinates = added.coordinates;
      remaining.splice(remaining.indexOf(selected), 1);
    }

    const travel = walkingMinutes(currentCoordinates, fixedCoordinates);
    if (travel >= 5 && cursor + travel <= fixed.start) {
      plan.push({
        id: `travel-event-${fixed.id}`,
        start: fixed.start - travel,
        end: fixed.start,
        title: `Walk to ${fixed.location}`,
        location: fixed.location,
        kind: "travel",
        reason: `Leave with about ${travel} minutes for walking.`,
      });
    }

    plan.push({
      id: `event-${fixed.id}`,
      start: Math.max(fixed.start, cursorStart),
      end: fixed.end,
      title: fixed.title,
      location: fixed.location,
      kind: "event",
      reason: "Fixed calendar event.",
    });
    cursor = fixed.end;
    currentCoordinates = fixedCoordinates;
  }

  const afterEventOrder: Candidate["category"][] = ["meal", "workout", "campus", "other", "admin", "home"];
  remaining.sort((first, second) =>
    afterEventOrder.indexOf(first.category) - afterEventOrder.indexOf(second.category)
    || walkingMinutes(currentCoordinates, first.coordinates) - walkingMinutes(currentCoordinates, second.coordinates));

  for (const candidate of remaining) {
    const added = addFlexibleItem(plan, candidate, cursor, currentCoordinates);
    cursor = added.cursor;
    currentCoordinates = added.coordinates;
  }

  const resolved = coordinateEntries.filter(([, value]) => value).length;
  const locationStatus = !locations.length
    ? "No addresses were available, so this plan uses time and task context only."
    : resolved === locations.length
      ? `Matched all ${resolved} location${resolved === 1 ? "" : "s"} and estimated walking time.`
      : `Matched ${resolved} of ${locations.length} locations. Add full addresses in Settings for better travel estimates.`;

  return {
    generatedAt: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(now),
    items: plan,
    locationStatus,
  };
}
