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

export async function ensureUser(): Promise<User | null> {
  const currentApp = firebaseApp();
  if (!currentApp) return null;
  const auth = getAuth(currentApp);
  if (auth.currentUser) return auth.currentUser;

  await signInAnonymously(auth);
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

function database() {
  const currentApp = firebaseApp();
  return currentApp ? getFirestore(currentApp) : null;
}

export async function loadProfile(userId: string) {
  const db = database();
  if (!db) return { memorySummary: "" };
  const snapshot = await getDoc(doc(db, "users", userId));
  if (!snapshot.exists()) {
    await setDoc(doc(db, "users", userId), {
      memorySummary: "",
      createdAt: serverTimestamp(),
    });
    return { memorySummary: "" };
  }
  return { memorySummary: String(snapshot.data().memorySummary ?? "") };
}

export async function saveMemorySummary(userId: string, memorySummary: string) {
  const db = database();
  if (!db) return;
  await setDoc(doc(db, "users", userId), {
    memorySummary,
    createdAt: serverTimestamp(),
  }, { merge: true });
}

export async function loadGoals(userId: string): Promise<Goal[]> {
  const db = database();
  if (!db) return [];
  const snapshot = await getDocs(collection(db, "users", userId, "goals"));
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
    };
  });
}

export async function addGoal(userId: string, goal: Omit<Goal, "id">) {
  const db = database();
  if (!db) return;
  await addDoc(collection(db, "users", userId, "goals"), {
    title: goal.title,
    status: goal.status,
    deadline: goal.deadline ? new Date(`${goal.deadline}T12:00:00`) : null,
    subSteps: goal.subSteps,
  });
}

export async function setGoalStatus(userId: string, goalId: string, status: Goal["status"]) {
  const db = database();
  if (!db) return;
  await updateDoc(doc(db, "users", userId, "goals", goalId), { status });
}

export async function removeGoal(userId: string, goalId: string) {
  const db = database();
  if (!db) return;
  await deleteDoc(doc(db, "users", userId, "goals", goalId));
}

export async function recordHabitDate(userId: string, name: string, date: string, completed: boolean) {
  const db = database();
  if (!db) return;
  const habits = collection(db, "users", userId, "habits");
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

export async function saveChatDay(userId: string, date: string, messages: StoredChatMessage[]) {
  const db = database();
  if (!db) return;
  await setDoc(doc(db, "users", userId, "chats", date), { date, messages });
}

export async function loadChatsBetween(userId: string, start: string, end: string) {
  const db = database();
  if (!db) return [];
  const snapshot = await getDocs(collection(db, "users", userId, "chats"));
  return snapshot.docs
    .map((item) => item.data() as { date: string; messages: StoredChatMessage[] })
    .filter((item) => item.date >= start && item.date <= end)
    .sort((first, second) => first.date.localeCompare(second.date));
}
