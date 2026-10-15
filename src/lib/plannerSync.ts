import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import type { Journal } from "../journal";
import { getFirestoreDb } from "./firebase";
import {
  mergeCheckInLogs,
  mergeHeartbeats,
  normalizeCheckInLog,
  normalizeHeartbeats,
  type CheckInLog,
  type DeviceHeartbeats,
} from "./checkIns";

/** Generic planner blob synced across devices. */
export type PlannerCloudState = {
  tasks: unknown[];
  habits: unknown[];
  schedule: unknown[];
  birthdays: unknown[];
  places: unknown;
  journal: Journal;
  checkIns: CheckInLog;
  deviceHeartbeats: DeviceHeartbeats;
  lastPlannerDay: string | null;
  updatedAtMs: number;
};

export async function loadPlannerState(ownerId: string): Promise<PlannerCloudState | null> {
  const db = getFirestoreDb();
  if (!db) return null;
  const snapshot = await getDoc(doc(db, "owners", ownerId, "planner", "main"));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return {
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    habits: Array.isArray(data.habits) ? data.habits : [],
    schedule: Array.isArray(data.schedule) ? data.schedule : [],
    birthdays: Array.isArray(data.birthdays) ? data.birthdays : [],
    places: data.places ?? { city: "Philadelphia, PA", places: [] },
    journal: (data.journal && typeof data.journal === "object") ? data.journal as Journal : {},
    checkIns: normalizeCheckInLog(data.checkIns),
    deviceHeartbeats: normalizeHeartbeats(data.deviceHeartbeats),
    lastPlannerDay: typeof data.lastPlannerDay === "string" ? data.lastPlannerDay : null,
    updatedAtMs: typeof data.updatedAtMs === "number" ? data.updatedAtMs : 0,
  };
}

export async function savePlannerState(ownerId: string, state: Omit<PlannerCloudState, "updatedAtMs">) {
  const db = getFirestoreDb();
  if (!db) return;
  // Deep-merge check-ins / heartbeats with whatever is already in the cloud so
  // one device can't wipe another device's half-hour logs (setDoc replaces maps).
  const existing = await loadPlannerState(ownerId);
  const checkIns = mergeCheckInLogs(existing?.checkIns ?? {}, state.checkIns ?? {});
  const deviceHeartbeats = mergeHeartbeats(existing?.deviceHeartbeats ?? {}, state.deviceHeartbeats ?? {});
  const updatedAtMs = Date.now();
  await setDoc(doc(db, "owners", ownerId, "planner", "main"), {
    ...state,
    checkIns,
    deviceHeartbeats,
    updatedAtMs,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  return updatedAtMs;
}

export function plannerStateIsEmpty(state: PlannerCloudState | null) {
  if (!state) return true;
  const placeList = state.places && typeof state.places === "object" && Array.isArray((state.places as { places?: unknown[] }).places)
    ? (state.places as { places: unknown[] }).places
    : [];
  return !(
    state.tasks.length
    || state.habits.length
    || state.schedule.length
    || state.birthdays.length
    || placeList.length
    || Object.keys(state.journal ?? {}).length
    || Object.keys(state.checkIns ?? {}).length
  );
}
