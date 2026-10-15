import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import type { Journal } from "../journal";
import { getFirestoreDb } from "./firebase";
import { normalizeCheckInLog, type CheckInLog } from "./checkIns";

/** Generic planner blob synced across devices. */
export type PlannerCloudState = {
  tasks: unknown[];
  habits: unknown[];
  schedule: unknown[];
  birthdays: unknown[];
  places: unknown;
  journal: Journal;
  checkIns: CheckInLog;
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
    lastPlannerDay: typeof data.lastPlannerDay === "string" ? data.lastPlannerDay : null,
    updatedAtMs: typeof data.updatedAtMs === "number" ? data.updatedAtMs : 0,
  };
}

export async function savePlannerState(ownerId: string, state: Omit<PlannerCloudState, "updatedAtMs">) {
  const db = getFirestoreDb();
  if (!db) return;
  const updatedAtMs = Date.now();
  await setDoc(doc(db, "owners", ownerId, "planner", "main"), {
    ...state,
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
