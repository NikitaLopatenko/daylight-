import { lifeStoryForPrompt } from "../data/lifeStory";
import { loadChatsBetween, loadGoals, loadProfile, type Goal, type StoredChatMessage } from "./firebase";

export function isGeminiConfigured() {
  return Boolean(import.meta.env.VITE_GEMINI_API_KEY);
}

export function detectDateRange(text: string, today: string): { start: string; end: string } | null {
  const explicit = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]);
  if (explicit.length >= 2) {
    const [start, end] = [...explicit].sort();
    return { start, end };
  }
  if (explicit.length === 1) return { start: explicit[0], end: explicit[0] };

  const lower = text.toLowerCase();
  if (/\byesterday\b/.test(lower)) {
    const date = shiftDate(today, -1);
    return { start: date, end: date };
  }
  if (/\blast week\b/.test(lower)) return { start: shiftDate(today, -7), end: today };
  if (/\blast month\b/.test(lower)) return { start: shiftDate(today, -30), end: today };
  if (/\bpast\b|\bprevious chats?\b|\bwhat did i\b/.test(lower)) {
    return { start: shiftDate(today, -14), end: today };
  }
  return null;
}

function shiftDate(dayKey: string, days: number) {
  const [year, month, date] = dayKey.split("-").map(Number);
  const next = new Date(year, month - 1, date + days, 12);
  const paddedMonth = String(next.getMonth() + 1).padStart(2, "0");
  const paddedDate = String(next.getDate()).padStart(2, "0");
  return `${next.getFullYear()}-${paddedMonth}-${paddedDate}`;
}

function describeGoals(goals: Goal[]) {
  const active = goals.filter((goal) => goal.status !== "done");
  if (!active.length) return "No active long-term goals yet.";
  return active.map((goal) => {
    const steps = goal.subSteps.length ? ` Steps: ${goal.subSteps.join("; ")}.` : "";
    const deadline = goal.deadline ? ` Deadline: ${goal.deadline}.` : "";
    const domain = goal.domain ? ` Domain: ${goal.domain}.` : "";
    const watches = goal.watchQueries?.length ? ` Watch: ${goal.watchQueries.join("; ")}.` : "";
    const people = goal.people?.length ? ` People/labs: ${goal.people.join("; ")}.` : "";
    const notes = goal.notes ? ` Notes: ${goal.notes}.` : "";
    return `- ${goal.title} (${goal.status}).${domain}${deadline}${steps}${watches}${people}${notes}`;
  }).join("\n");
}

export async function askPlanner(input: {
  userId: string | null;
  today: string;
  message: string;
  history: StoredChatMessage[];
}) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini is not configured.");

  const profile = input.userId
    ? await loadProfile(input.userId)
    : { memorySummary: "", lifeStory: "" };
  const goals = input.userId ? await loadGoals(input.userId) : [];
  const range = input.userId ? detectDateRange(input.message, input.today) : null;
  const pastChats = input.userId && range
    ? await loadChatsBetween(input.userId, range.start, range.end)
    : [];
  const pastText = pastChats.length
    ? pastChats.map((chat) => `${chat.date}\n${chat.messages.map((message) => `${message.role}: ${message.content}`).join("\n")}`).join("\n\n")
    : "No saved chats were requested for a past date range.";
  const lifeStory = lifeStoryForPrompt(profile.lifeStory);

  const system = [
    "You are Daylight, an AI life planner for one person.",
    "Use the life story, profile memory, and goals below when you give advice.",
    "Prefer real past relationships and open loops from the life story when suggesting outreach or opportunities.",
    "Do not invent faculty promises, publications, or acceptances that are not in the life story.",
    "Keep plans realistic around classes, meals, energy, and travel.",
    "If they ask what they did on a past date, use only the saved chat logs. Do not invent completed tasks.",
    "When they set a long-term goal, restate the goal, a deadline if they gave one, and 3 to 5 concrete sub-steps.",
    "",
    `Today is ${input.today}.`,
    `Profile memory: ${profile.memorySummary || "No long-term memory summary yet."}`,
    "Life story / relationship map:",
    lifeStory || "No life story synced yet.",
    "",
    "Active goals:",
    describeGoals(goals),
    "",
    "Saved chats for the requested dates:",
    pastText,
  ].join("\n");

  const contents = [
    ...input.history.slice(-12).map((message) => ({
      role: message.role,
      parts: [{ text: message.content }],
    })),
    { role: "user", parts: [{ text: input.message }] },
  ];

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status}).`);
  }
  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const reply = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!reply) throw new Error("Gemini returned an empty reply.");
  return reply;
}
