import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInAnonymously, type User } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Timestamp,
} from "firebase/firestore";

export type Goal = {
  id: string;
  title: string;
  status: "active" | "paused" | "done";
  deadline: string;
  subSteps: string[];
  /** career | research | academic | personal | other */
  domain: string;
  /** Topics/queries the morning scout should watch */
  watchQueries: string[];
  /** People, labs, orgs, PIs to watch for openings/signals */
  people: string[];
  notes: string;
};

export type StoredChatMessage = {
  role: "user" | "model";
  content: string;
};

type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

let app: FirebaseApp | null = null;
let authReady: Promise<User | null> | null = null;

function readConfig(): FirebaseConfig | null {
  const raw = import.meta.env.VITE_FIREBASE_CONFIG;
  if (raw) {
    try {
      return JSON.parse(raw) as FirebaseConfig;
    } catch {
      return null;
    }
  }

  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "";
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const storageBucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "";
  const messagingSenderId = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "";
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;
  if (!apiKey || !projectId || !appId) return null;
  return { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId };
}

export function isFirebaseConfigured() {
  return readConfig() !== null;
}

function firebaseApp() {
  const config = readConfig();
  if (!config) return null;
  app ??= initializeApp(config);
  return app;
}

/** Anonymous auth only — just so Firestore rules see request.auth. Sync identity is the sync key. */
export async function ensureUser(): Promise<User | null> {
  const currentApp = firebaseApp();
  if (!currentApp) return null;
  const auth = getAuth(currentApp);
  if (auth.currentUser) {
    authReady = Promise.resolve(auth.currentUser);
    return auth.currentUser;
  }
  if (!authReady) {
    authReady = (async () => {
      try {
        const cred = await signInAnonymously(auth);
        return cred.user;
      } catch {
        return new Promise((resolve) => {
          const unsubscribe = onAuthStateChanged(auth, (user) => {
            unsubscribe();
            resolve(user);
          });
        });
      }
    })();
  }
  return authReady;
}

function database() {
  const currentApp = firebaseApp();
  return currentApp ? getFirestore(currentApp) : null;
}

export function getFirestoreDb() {
  return database();
}

export async function loadProfile(ownerId: string) {
  const db = database();
  if (!db) return { memorySummary: "", scoutPrompt: "", lifeStory: "" };
  const snapshot = await getDoc(doc(db, "owners", ownerId));
  if (!snapshot.exists()) {
    await setDoc(doc(db, "owners", ownerId), {
      memorySummary: "",
      scoutPrompt: "",
      lifeStory: "",
      createdAt: serverTimestamp(),
    });
    return { memorySummary: "", scoutPrompt: "", lifeStory: "" };
  }
  return {
    memorySummary: String(snapshot.data().memorySummary ?? ""),
    scoutPrompt: String(snapshot.data().scoutPrompt ?? ""),
    lifeStory: String(snapshot.data().lifeStory ?? ""),
  };
}

export async function saveMemorySummary(ownerId: string, memorySummary: string) {
  const db = database();
  if (!db) return;
  await setDoc(doc(db, "owners", ownerId), {
    memorySummary,
    createdAt: serverTimestamp(),
  }, { merge: true });
}

/** Full life autobiography for opportunity / relationship-aware planning. */
export async function saveLifeStory(ownerId: string, lifeStory: string) {
  const db = database();
  if (!db) return;
  await setDoc(doc(db, "owners", ownerId), {
    lifeStory,
    lifeStoryUpdatedAt: serverTimestamp(),
  }, { merge: true });
}

/** Keep the Gemini-app news prompt synced with the latest goals. */
export async function saveScoutPrompt(ownerId: string, scoutPrompt: string) {
  const db = database();
  if (!db) return;
  await setDoc(doc(db, "owners", ownerId), {
    scoutPrompt,
    scoutPromptUpdatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function loadGoals(ownerId: string): Promise<Goal[]> {
  const db = database();
  if (!db) return [];
  const snapshot = await getDocs(collection(db, "owners", ownerId, "goals"));
  return snapshot.docs.map((item) => {
    const data = item.data();
    const deadline = data.deadline as Timestamp | string | undefined;
    const deadlineText = typeof deadline === "string"
      ? deadline
      : deadline?.toDate?.().toISOString().slice(0, 10) ?? "";
    return {
      id: item.id,
      title: String(data.title ?? ""),
      status: (data.status as Goal["status"]) || "active",
      deadline: deadlineText,
      subSteps: Array.isArray(data.subSteps) ? data.subSteps.map(String) : [],
      domain: String(data.domain ?? ""),
      watchQueries: Array.isArray(data.watchQueries) ? data.watchQueries.map(String) : [],
      people: Array.isArray(data.people) ? data.people.map(String) : [],
      notes: String(data.notes ?? ""),
    };
  });
}

/** One-time copy from old anonymous users/{uid} into owners/{syncKey}. */
export async function migrateLegacyUserToOwner(legacyUserId: string, ownerId: string) {
  const db = database();
  if (!db || !legacyUserId || legacyUserId === ownerId) return false;
  const ownerSnap = await getDoc(doc(db, "owners", ownerId));
  const ownerGoals = await getDocs(collection(db, "owners", ownerId, "goals"));
  if (ownerSnap.exists() && (ownerSnap.data().memorySummary || ownerSnap.data().lifeStory || ownerGoals.size > 0)) {
    return false;
  }

  const legacyProfile = await getDoc(doc(db, "users", legacyUserId));
  const legacyGoals = await getDocs(collection(db, "users", legacyUserId, "goals"));
  if (!legacyProfile.exists() && legacyGoals.empty) return false;

  if (legacyProfile.exists()) {
    const data = legacyProfile.data();
    await setDoc(doc(db, "owners", ownerId), {
      memorySummary: data.memorySummary ?? "",
      scoutPrompt: data.scoutPrompt ?? "",
      lifeStory: data.lifeStory ?? "",
      migratedFrom: legacyUserId,
      createdAt: serverTimestamp(),
    }, { merge: true });
  }

  for (const item of legacyGoals.docs) {
    await setDoc(doc(db, "owners", ownerId, "goals", item.id), item.data(), { merge: true });
  }
  return true;
}

export async function addGoal(ownerId: string, goal: Omit<Goal, "id">) {
  const db = database();
  if (!db) return;
  await addDoc(collection(db, "owners", ownerId, "goals"), {
    title: goal.title,
    status: goal.status,
    deadline: goal.deadline ? new Date(`${goal.deadline}T12:00:00`) : null,
    subSteps: goal.subSteps,
    domain: goal.domain || "",
    watchQueries: goal.watchQueries,
    people: goal.people,
    notes: goal.notes || "",
  });
}

export async function updateGoal(ownerId: string, goalId: string, patch: Partial<Omit<Goal, "id">>) {
  const db = database();
  if (!db) return;
  const payload: Record<string, unknown> = {};
  if (patch.title !== undefined) payload.title = patch.title;
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.deadline !== undefined) {
    payload.deadline = patch.deadline ? new Date(`${patch.deadline}T12:00:00`) : null;
  }
  if (patch.subSteps !== undefined) payload.subSteps = patch.subSteps;
  if (patch.domain !== undefined) payload.domain = patch.domain;
  if (patch.watchQueries !== undefined) payload.watchQueries = patch.watchQueries;
  if (patch.people !== undefined) payload.people = patch.people;
  if (patch.notes !== undefined) payload.notes = patch.notes;
  await updateDoc(doc(db, "owners", ownerId, "goals", goalId), payload);
}

export async function setGoalStatus(ownerId: string, goalId: string, status: Goal["status"]) {
  const db = database();
  if (!db) return;
  await updateDoc(doc(db, "owners", ownerId, "goals", goalId), { status });
}

export async function removeGoal(ownerId: string, goalId: string) {
  const db = database();
  if (!db) return;
  await deleteDoc(doc(db, "owners", ownerId, "goals", goalId));
}

export async function recordHabitDate(ownerId: string, name: string, date: string, completed: boolean) {
  const db = database();
  if (!db) return;
  const habits = collection(db, "owners", ownerId, "habits");
  const snapshot = await getDocs(habits);
  const existing = snapshot.docs.find((item) => item.data().name === name);
  if (!existing) {
    if (completed) await addDoc(habits, { name, completedDates: [date] });
    return;
  }
  const dates = new Set<string>(Array.isArray(existing.data().completedDates) ? existing.data().completedDates : []);
  if (completed) dates.add(date);
  else dates.delete(date);
  await updateDoc(existing.ref, { completedDates: [...dates].sort() });
}

export async function saveChatDay(ownerId: string, date: string, messages: StoredChatMessage[]) {
  const db = database();
  if (!db) return;
  await setDoc(doc(db, "owners", ownerId, "chats", date), { date, messages });
}

export async function loadChatsBetween(ownerId: string, start: string, end: string) {
  const db = database();
  if (!db) return [];
  const snapshot = await getDocs(collection(db, "owners", ownerId, "chats"));
  return snapshot.docs
    .map((item) => item.data() as { date: string; messages: StoredChatMessage[] })
    .filter((item) => item.date >= start && item.date <= end)
    .sort((first, second) => first.date.localeCompare(second.date));
}
