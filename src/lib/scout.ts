import { lifeStoryForPrompt } from "../data/lifeStory";
import type { Goal } from "./firebase";
import { openExternal } from "./openExternal";

export type OpportunityKind = "opening" | "publication" | "event" | "signal" | "news" | "other";

export type Opportunity = {
  id: string;
  goalId: string;
  goalTitle: string;
  kind: OpportunityKind;
  title: string;
  summary: string;
  whyItMatters: string;
  nextSteps: string[];
  url?: string;
  source?: string;
};

export type MorningBriefing = {
  date: string;
  generatedAt: string;
  summary: string;
  nextActions: string[];
  opportunities: Opportunity[];
  sourcesNote: string;
  source: "gemini-app" | "gemini-api" | "openalex" | "empty";
};

const STORAGE_KEY = "daylight-briefings";
export const GEMINI_APP_URL = "https://gemini.google.com/app";

type PaperHit = {
  goalId: string;
  goalTitle: string;
  title: string;
  url: string;
  date: string;
  authors: string;
};

type ScoutJson = {
  summary?: string;
  nextActions?: string[];
  opportunities?: Array<{
    goalId?: string;
    goalTitle?: string;
    kind?: string;
    title?: string;
    summary?: string;
    whyItMatters?: string;
    nextSteps?: string[] | string;
    url?: string;
    source?: string;
  }>;
};

function splitList(value: string) {
  return value.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
}

export function readBriefings(): Record<string, MorningBriefing> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, MorningBriefing>;
  } catch {
    return {};
  }
}

export function readBriefing(date: string) {
  return readBriefings()[date] ?? null;
}

export function writeBriefing(briefing: MorningBriefing) {
  const all = readBriefings();
  all[briefing.date] = briefing;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function goalScoutTargets(goals: Goal[]) {
  return goals.filter((goal) => goal.status === "active" && (
    goal.watchQueries.length > 0 || goal.people.length > 0 || Boolean(goal.title.trim())
  ));
}

function describeGoalsBlock(goals: Goal[]) {
  return goals.map((goal) => {
    const watches = goal.watchQueries.length ? goal.watchQueries.join("; ") : "(none)";
    const people = goal.people.length ? goal.people.join("; ") : "(none)";
    const steps = goal.subSteps.length ? goal.subSteps.join("; ") : "(none)";
    return [
      `Goal id: ${goal.id}`,
      `Title: ${goal.title}`,
      `Domain: ${goal.domain || "unspecified"}`,
      `Deadline: ${goal.deadline || "none"}`,
      `Watch queries: ${watches}`,
      `People / labs / orgs: ${people}`,
      `Sub-steps: ${steps}`,
      `Notes: ${goal.notes || "(none)"}`,
    ].join("\n");
  }).join("\n\n");
}

function jsonShapeHint() {
  return [
    "Return ONLY valid JSON (no markdown outside the JSON) with this exact shape:",
    "{",
    '  "summary": "2-4 sentence morning rundown",',
    '  "nextActions": ["concrete reaction step 1", "step 2", "step 3"],',
    '  "opportunities": [',
    "    {",
    '      "goalId": "string",',
    '      "goalTitle": "string",',
    '      "kind": "opening"|"publication"|"event"|"signal"|"news"|"other",',
    '      "title": "string",',
    '      "summary": "what happened",',
    '      "whyItMatters": "why this helps the goal",',
    '      "nextSteps": ["what to do next"],',
    '      "url": "https://...",',
    '      "source": "site or publisher"',
    "    }",
    "  ]",
    "}",
    "Return at most 8 opportunities, ranked by usefulness. Prefer the last 60 days. Do not invent URLs.",
    "LinkedIn private profiles cannot be scraped; only use publicly indexed posts/news.",
  ].join("\n");
}

/** Prompt built from current Firebase goals — meant for Gemini app (Pro / Deep Research). */
export function buildGeminiNewsPrompt(goals: Goal[], today: string, lifeStory = "") {
  const active = goalScoutTargets(goals);
  const goalBlock = active.length
    ? describeGoalsBlock(active)
    : "No active goals yet. Ask what I should watch for career/research opportunities.";
  const story = lifeStoryForPrompt(lifeStory);

  return [
    "You are my morning opportunity / news scout for Daylight.",
    "I pasted this from my Daylight goals and life story. Use Google Search / extended search if available.",
    "Find timely openings, publications, conferences/talks, lab/PI news, and public signals tied to these goals.",
    "Use the life story to prioritize warm connections, open loops, and realistic next moves (e.g. people I already met).",
    "Respect relationship cautions in the life story (e.g. do not push cold re-contact after a hard no).",
    "Do not invent faculty promises or publications that are not in the life story.",
    "Then tell me what happened and what I should do next.",
    "",
    jsonShapeHint(),
    "",
    `Today is ${today}.`,
    "",
    "My current long-term goals / objectives:",
    goalBlock,
    "",
    "My life story / relationship map (use for connection-aware opportunities):",
    story || "(No life story provided yet.)",
  ].join("\n");
}

async function fetchOpenAlexPapers(goals: Goal[]): Promise<PaperHit[]> {
  const hits: PaperHit[] = [];
  const active = goalScoutTargets(goals).slice(0, 4);

  await Promise.all(active.map(async (goal) => {
    const query = [...goal.watchQueries, ...goal.people, goal.title].filter(Boolean).slice(0, 3).join(" ");
    if (!query.trim()) return;
    try {
      const fromYear = new Date().getFullYear() - 1;
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("search", query);
      url.searchParams.set("per_page", "3");
      url.searchParams.set("sort", "publication_date:desc");
      url.searchParams.set("filter", `from_publication_date:${fromYear}-01-01`);
      url.searchParams.set("mailto", "daylight-local@example.com");

      const response = await fetch(url.toString());
      if (!response.ok) return;
      const data = await response.json() as {
        results?: Array<{
          display_name?: string;
          publication_date?: string;
          id?: string;
          doi?: string;
          authorships?: Array<{ author?: { display_name?: string } }>;
          primary_location?: { landing_page_url?: string };
        }>;
      };
      for (const work of data.results ?? []) {
        const link = work.primary_location?.landing_page_url
          || (work.doi ? `https://doi.org/${work.doi.replace(/^https?:\/\/doi\.org\//, "")}` : work.id)
          || "";
        hits.push({
          goalId: goal.id,
          goalTitle: goal.title,
          title: work.display_name ?? "Untitled paper",
          url: link,
          date: work.publication_date ?? "",
          authors: (work.authorships ?? [])
            .map((item) => item.author?.display_name)
            .filter(Boolean)
            .slice(0, 4)
            .join(", "),
        });
      }
    } catch {
      // OpenAlex is best-effort.
    }
  }));

  return hits;
}

function extractJson(text: string): ScoutJson {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Response was not JSON. Copy Gemini’s JSON reply and paste it again.");
  return JSON.parse(raw.slice(start, end + 1)) as ScoutJson;
}

function normalizeKind(value: string | undefined): OpportunityKind {
  const kind = (value ?? "other").toLowerCase();
  if (kind === "opening" || kind === "publication" || kind === "event" || kind === "signal" || kind === "news") {
    return kind;
  }
  return "other";
}

function normalizeSteps(value: string[] | string | undefined) {
  if (Array.isArray(value)) return value.map(String).map((step) => step.trim()).filter(Boolean);
  if (typeof value === "string") return splitList(value);
  return [];
}

function briefingFromJson(
  parsed: ScoutJson,
  today: string,
  source: MorningBriefing["source"],
  sourcesNote: string,
): MorningBriefing {
  const opportunities = (parsed.opportunities ?? []).slice(0, 8).map((item, index) => ({
    id: `${today}-${index}`,
    goalId: String(item.goalId ?? ""),
    goalTitle: String(item.goalTitle ?? ""),
    kind: normalizeKind(item.kind),
    title: String(item.title ?? "Opportunity"),
    summary: String(item.summary ?? ""),
    whyItMatters: String(item.whyItMatters ?? ""),
    nextSteps: normalizeSteps(item.nextSteps),
    url: item.url?.trim() || undefined,
    source: item.source?.trim() || undefined,
  }));

  return {
    date: today,
    generatedAt: new Date().toISOString(),
    summary: parsed.summary?.trim() || "Morning opportunity briefing ready.",
    nextActions: normalizeSteps(parsed.nextActions),
    opportunities,
    sourcesNote,
    source,
  };
}

/** Parse a Gemini app (or API) reply and save it as today’s briefing. */
export function importGeminiBriefing(rawText: string, today: string): MorningBriefing {
  const parsed = extractJson(rawText);
  const briefing = briefingFromJson(
    parsed,
    today,
    "gemini-app",
    "Imported from Gemini app (your subscription / Deep Research).",
  );
  writeBriefing(briefing);
  return briefing;
}

/** Copy the latest goal prompt and open Gemini in the browser. */
export async function launchGeminiNewsScout(prompt: string) {
  try {
    await navigator.clipboard.writeText(prompt);
  } catch {
    throw new Error("Could not copy the prompt to the clipboard. Allow clipboard access and try again.");
  }

  await openExternal(GEMINI_APP_URL);
}

async function askGeminiScout(prompt: string) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key is not configured.");

  const models = ["gemini-2.5-flash", "gemini-3.8-flash"];
  let lastError = "Gemini scout failed.";

  for (const model of models) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.3 },
        }),
      },
    );
    if (!response.ok) {
      lastError = `Gemini scout failed (${response.status}) on ${model}.`;
      continue;
    }
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) {
      lastError = `Gemini returned an empty scout reply on ${model}.`;
      continue;
    }
    return text;
  }

  throw new Error(lastError);
}

export async function runMorningScout(goals: Goal[], today: string, lifeStory = ""): Promise<MorningBriefing> {
  const active = goalScoutTargets(goals);
  if (!active.length) {
    const empty: MorningBriefing = {
      date: today,
      generatedAt: new Date().toISOString(),
      summary: "No active goals to scout yet. Add a goal with watch topics or people.",
      nextActions: ["Add or update a goal in Goals with watch topics and people to monitor."],
      opportunities: [],
      sourcesNote: "Waiting on goals.",
      source: "empty",
    };
    writeBriefing(empty);
    return empty;
  }

  const papers = await fetchOpenAlexPapers(active);
  const paperBlock = papers.length
    ? papers.map((paper) => (
      `- [${paper.goalTitle}] ${paper.title} (${paper.date}) by ${paper.authors || "unknown"} · ${paper.url}`
    )).join("\n")
    : "No OpenAlex hits yet.";

  const prompt = [
    buildGeminiNewsPrompt(goals, today, lifeStory),
    "",
    "Recent papers already found via OpenAlex (free academic index):",
    paperBlock,
    "",
    "Use those papers when relevant, and search for additional openings/events/news.",
  ].join("\n");

  try {
    const text = await askGeminiScout(prompt);
    const briefing = briefingFromJson(
      extractJson(text),
      today,
      "gemini-api",
      "Built via Gemini API Google Search (fallback path).",
    );
    writeBriefing(briefing);
    return briefing;
  } catch (error) {
    const briefing: MorningBriefing = {
      date: today,
      generatedAt: new Date().toISOString(),
      summary: papers.length
        ? "API search was unavailable. Showing recent academic publications related to your goals. Prefer “Open in Gemini” to use your subscription."
        : `API scout failed (${error instanceof Error ? error.message : "error"}). Use “Open in Gemini” with your subscription instead.`,
      nextActions: [
        "Click Open in Gemini, paste (Ctrl+V), run the search there.",
        "Copy Gemini’s JSON reply and paste it back into Daylight.",
      ],
      opportunities: papers.slice(0, 8).map((paper, index) => ({
        id: `${today}-paper-${index}`,
        goalId: paper.goalId,
        goalTitle: paper.goalTitle,
        kind: "publication" as const,
        title: paper.title,
        summary: `Recent work${paper.authors ? ` by ${paper.authors}` : ""}${paper.date ? ` (${paper.date})` : ""}.`,
        whyItMatters: `Related to your goal “${paper.goalTitle}”.`,
        nextSteps: ["Skim the abstract and note one talking point or open problem."],
        url: paper.url || undefined,
        source: "OpenAlex",
      })),
      sourcesNote: "OpenAlex only (free). Gemini app import is the preferred paid-search path.",
      source: "openalex",
    };
    writeBriefing(briefing);
    return briefing;
  }
}

export { splitList };
