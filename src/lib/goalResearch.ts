import { lifeStoryForPrompt } from "../data/lifeStory";
import type { Goal } from "./firebase";
import { macroIsReady, readScoutMacroConfig, runGeminiScreenMacro } from "./scoutMacro";
import { launchGeminiNewsScout } from "./scout";

export type ResearchLens =
  | "academic_fit"
  | "warm_connections"
  | "referral_network"
  | "events_networking"
  | "industry_fit";

export type LensFinding = {
  lens: ResearchLens;
  /** 0–1 importance of this lens for reaching the goal */
  weight: number;
  people: string[];
  watchQueries: string[];
  signals: string[];
  nextMoves: string[];
  rationale: string;
};

export type DeepBriefing = {
  /** What the target lab/PI/org is working on now */
  currentWork: string[];
  /** How the user's background aligns */
  alignment: string[];
  /** Warm intros / referral paths (esp. current university) */
  referrals: string[];
  /** Talks, conferences, visits where networking is realistic */
  events: string[];
};

export type GoalResearchPlan = {
  goalId: string;
  goalTitle: string;
  summary: string;
  pathStrategy: string;
  deepBriefing: DeepBriefing;
  lenses: LensFinding[];
  proposedWatchQueries: string[];
  proposedPeople: string[];
  proposedNotes: string;
  proposedSubSteps: string[];
  source: "api-agents" | "gemini-app";
};

type LensJson = {
  weight?: number;
  people?: string[];
  watchQueries?: string[];
  signals?: string[];
  nextMoves?: string[];
  rationale?: string;
  currentWork?: string[];
  alignment?: string[];
  referrals?: string[];
  events?: string[];
};

const LENS_ORDER: ResearchLens[] = [
  "academic_fit",
  "warm_connections",
  "referral_network",
  "events_networking",
  "industry_fit",
];

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Research agent did not return JSON.");
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

function asStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function clampWeight(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

async function askGeminiJson(prompt: string) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini is not configured. Add VITE_GEMINI_API_KEY to .env.");

  const models = ["gemini-2.5-flash", "gemini-3.8-flash"];
  let lastError = "Goal research failed.";

  for (const model of models) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.35 },
        }),
      },
    );
    if (!response.ok) {
      lastError = `Goal research failed (${response.status}) on ${model}.`;
      continue;
    }
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) {
      lastError = `Empty research reply on ${model}.`;
      continue;
    }
    return text;
  }

  throw new Error(lastError);
}

function goalContext(goal: Goal, memorySummary: string, lifeStory: string) {
  return [
    `Goal title: ${goal.title}`,
    `Domain: ${goal.domain || "unspecified"}`,
    `Deadline: ${goal.deadline || "none"}`,
    `Existing sub-steps: ${goal.subSteps.join("; ") || "(none)"}`,
    `Existing watch queries: ${goal.watchQueries.join("; ") || "(none)"}`,
    `Existing people: ${goal.people.join("; ") || "(none)"}`,
    `Existing notes: ${goal.notes || "(none)"}`,
    `User memory / constraints: ${memorySummary || "(none)"}`,
    "",
    "Life story / relationship map (prefer warm ties and open loops; respect cautions):",
    lifeStoryForPrompt(lifeStory) || "(none)",
  ].join("\n");
}

function lensRole(lens: ResearchLens) {
  const roles: Record<ResearchLens, string> = {
    academic_fit:
      "ACADEMIC FIT agent. Research what the target PI/lab/org is working on NOW (recent papers, lab page, methods, open problems). Compare to the user's research trajectory. Be specific.",
    warm_connections:
      "WARM CONNECTIONS agent. From the life story, identify people the user already met who matter for this goal, what was said, and safe reopen moves. Respect cautions (e.g. do not push after a hard no).",
    referral_network:
      "REFERRAL / CAMPUS NETWORK agent. Find who at the user's CURRENT university (or nearby) could introduce, advise, or refer toward this goal — advisors, collaborators, alumni, related labs. Prefer named people from life story + public faculty pages.",
    events_networking:
      "EVENTS / NETWORKING agent. Find upcoming or recurring public talks, conferences, seminars, office hours, workshops, or visits where the user could reasonably meet the target or their group. Prefer next 6 months; include location if known.",
    industry_fit:
      "INDUSTRY / PROOF agent. Infer skills, tools, internships, portfolio proof, and company/lab links that make the user useful to this target. Suggest concrete artifacts to build.",
  };
  return roles[lens];
}

function lensPrompt(lens: ResearchLens, goal: Goal, memorySummary: string, lifeStory: string) {
  return [
    `You are Daylight's ${lensRole(lens)}`,
    "The user stated a high-level goal. Do NOT only restate keywords — research how to get there.",
    "Use Google Search aggressively. Prefer concrete, checkable items with names, paper titles, event names when possible.",
    "Do not invent faculty promises, publications, or acceptances absent from the life story.",
    "If unsure, say so in rationale rather than fabricating.",
    "Return ONLY JSON:",
    "{",
    '  "weight": 0.0-1.0,',
    '  "people": ["names / labs / orgs"],',
    '  "watchQueries": ["search queries for ongoing monitoring"],',
    '  "signals": ["what a useful opportunity/signal looks like"],',
    '  "nextMoves": ["concrete actions in the next 1-4 weeks"],',
    '  "currentWork": ["only for academic_fit: what they work on now"],',
    '  "alignment": ["only for academic_fit / industry_fit: how user aligns"],',
    '  "referrals": ["only for warm_connections / referral_network: referral paths"],',
    '  "events": ["only for events_networking: talks/events"],',
    '  "rationale": "why this lens matters"',
    "}",
    "",
    goalContext(goal, memorySummary, lifeStory),
  ].join("\n");
}

function parseLens(lens: ResearchLens, text: string, fallbackWeight: number): LensFinding & Partial<DeepBriefing> {
  const json = extractJson(text) as LensJson;
  return {
    lens,
    weight: clampWeight(json.weight, fallbackWeight),
    people: asStringList(json.people).slice(0, 12),
    watchQueries: asStringList(json.watchQueries).slice(0, 14),
    signals: asStringList(json.signals).slice(0, 10),
    nextMoves: asStringList(json.nextMoves).slice(0, 8),
    rationale: String(json.rationale ?? "").trim(),
    currentWork: asStringList(json.currentWork).slice(0, 8),
    alignment: asStringList(json.alignment).slice(0, 8),
    referrals: asStringList(json.referrals).slice(0, 8),
    events: asStringList(json.events).slice(0, 8),
  };
}

function defaultWeights(domain: string): Record<ResearchLens, number> {
  const normalized = domain.toLowerCase();
  if (normalized === "career") {
    return {
      academic_fit: 0.15,
      warm_connections: 0.2,
      referral_network: 0.2,
      events_networking: 0.15,
      industry_fit: 0.3,
    };
  }
  return {
    academic_fit: 0.28,
    warm_connections: 0.22,
    referral_network: 0.2,
    events_networking: 0.18,
    industry_fit: 0.12,
  };
}

function uniqueByWeight(items: Array<{ value: string; weight: number }>) {
  const best = new Map<string, number>();
  for (const item of items) {
    const key = item.value.toLowerCase();
    best.set(key, Math.max(best.get(key) ?? 0, item.weight));
  }
  return [...best.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([key]) => {
      const original = items.find((item) => item.value.toLowerCase() === key)?.value;
      return original ?? key;
    });
}

function emptyBriefing(): DeepBriefing {
  return { currentWork: [], alignment: [], referrals: [], events: [] };
}

function mergePlan(
  goal: Goal,
  lenses: Array<LensFinding & Partial<DeepBriefing>>,
  source: GoalResearchPlan["source"],
): GoalResearchPlan {
  const weightedPeople = lenses.flatMap((lens) =>
    lens.people.map((value) => ({ value, weight: lens.weight })),
  );
  const weightedQueries = lenses.flatMap((lens) =>
    lens.watchQueries.map((value) => ({ value, weight: lens.weight })),
  );
  const weightedSteps = lenses.flatMap((lens) =>
    lens.nextMoves.map((value) => ({ value, weight: lens.weight })),
  );

  const proposedPeople = uniqueByWeight(weightedPeople).slice(0, 16);
  const proposedWatchQueries = uniqueByWeight(weightedQueries).slice(0, 18);
  const proposedSubSteps = uniqueByWeight(weightedSteps).slice(0, 10);

  const rankedLenses = [...lenses]
    .map(({ currentWork: _c, alignment: _a, referrals: _r, events: _e, ...lens }) => lens)
    .sort((left, right) => right.weight - left.weight);

  const deepBriefing: DeepBriefing = {
    currentWork: uniqueByWeight(
      lenses.flatMap((lens) => (lens.currentWork ?? []).map((value) => ({ value, weight: lens.weight }))),
    ).slice(0, 10),
    alignment: uniqueByWeight(
      lenses.flatMap((lens) => (lens.alignment ?? []).map((value) => ({ value, weight: lens.weight }))),
    ).slice(0, 10),
    referrals: uniqueByWeight(
      lenses.flatMap((lens) => (lens.referrals ?? []).map((value) => ({ value, weight: lens.weight }))),
    ).slice(0, 10),
    events: uniqueByWeight(
      lenses.flatMap((lens) => (lens.events ?? []).map((value) => ({ value, weight: lens.weight }))),
    ).slice(0, 10),
  };

  const pathStrategy = rankedLenses
    .map((lens) => `${lens.lens} (${Math.round(lens.weight * 100)}%): ${lens.rationale || "n/a"}`)
    .join(" ");

  const proposedNotes = [
    `Path strategy: ${pathStrategy}`,
    deepBriefing.currentWork.length ? `Current work:\n- ${deepBriefing.currentWork.join("\n- ")}` : "",
    deepBriefing.alignment.length ? `Alignment:\n- ${deepBriefing.alignment.join("\n- ")}` : "",
    deepBriefing.referrals.length ? `Referrals / warm paths:\n- ${deepBriefing.referrals.join("\n- ")}` : "",
    deepBriefing.events.length ? `Events / networking:\n- ${deepBriefing.events.join("\n- ")}` : "",
    goal.notes ? `Original notes: ${goal.notes}` : "",
  ].filter(Boolean).join("\n\n");

  const summary = [
    `Deep-researched “${goal.title}” with ${rankedLenses.length} specialist agents (${source}).`,
    `Coverage: work=${deepBriefing.currentWork.length}, alignment=${deepBriefing.alignment.length}, referrals=${deepBriefing.referrals.length}, events=${deepBriefing.events.length}.`,
    `Proposed ${proposedPeople.length} people/orgs and ${proposedWatchQueries.length} watch queries.`,
  ].join(" ");

  return {
    goalId: goal.id,
    goalTitle: goal.title,
    summary,
    pathStrategy,
    deepBriefing,
    lenses: rankedLenses,
    proposedWatchQueries,
    proposedPeople,
    proposedNotes,
    proposedSubSteps,
    source,
  };
}

/** Build a single Deep Research prompt for Gemini Pro (app / Deep Research). */
export function buildDeepResearchPrompt(goal: Goal, memorySummary: string, lifeStory: string) {
  return [
    "You are Daylight's deep goal-path researcher. Use Deep Research / Google Search if available.",
    "Goal: research HOW TO GET THERE — not just keyword restatement.",
    "You must cover ALL four required sections with concrete bullets:",
    "1) currentWork — what the target PI/lab/org is working on now",
    "2) alignment — how the user's background fits (cite life story)",
    "3) referrals — warm intros / campus people who could help (esp. current university)",
    "4) events — talks/conferences/visits where networking is realistic",
    "Also run five specialist lenses in the JSON: academic_fit, warm_connections, referral_network, events_networking, industry_fit.",
    "Respect relationship cautions in the life story. Do not invent publications or promises.",
    "Return ONLY JSON:",
    "{",
    '  "summary": string,',
    '  "deepBriefing": {',
    '    "currentWork": string[],',
    '    "alignment": string[],',
    '    "referrals": string[],',
    '    "events": string[]',
    "  },",
    '  "lenses": [',
    "    {",
    '      "lens": "academic_fit"|"warm_connections"|"referral_network"|"events_networking"|"industry_fit",',
    '      "weight": 0-1,',
    '      "people": string[],',
    '      "watchQueries": string[],',
    '      "signals": string[],',
    '      "nextMoves": string[],',
    '      "rationale": string',
    "    }",
    "  ],",
    '  "proposedPeople": string[],',
    '  "proposedWatchQueries": string[],',
    '  "proposedSubSteps": string[],',
    '  "proposedNotes": string',
    "}",
    "",
    goalContext(goal, memorySummary, lifeStory),
  ].join("\n");
}

/** Parse a Gemini Pro / Deep Research JSON reply into a confirmable plan. */
export function parseDeepResearchPlan(rawText: string, goal: Goal): GoalResearchPlan {
  const json = extractJson(rawText);
  const briefingRaw = (json.deepBriefing ?? {}) as Record<string, unknown>;
  const deepBriefing: DeepBriefing = {
    currentWork: asStringList(briefingRaw.currentWork).slice(0, 12),
    alignment: asStringList(briefingRaw.alignment).slice(0, 12),
    referrals: asStringList(briefingRaw.referrals).slice(0, 12),
    events: asStringList(briefingRaw.events).slice(0, 12),
  };

  const lensesRaw = Array.isArray(json.lenses) ? json.lenses : [];
  const lenses: LensFinding[] = lensesRaw.map((item, index) => {
    const row = item as LensJson & { lens?: string };
    const lensName = (String(row.lens ?? LENS_ORDER[index] ?? "academic_fit") as ResearchLens);
    return {
      lens: LENS_ORDER.includes(lensName) ? lensName : "academic_fit",
      weight: clampWeight(row.weight, 0.2),
      people: asStringList(row.people).slice(0, 12),
      watchQueries: asStringList(row.watchQueries).slice(0, 14),
      signals: asStringList(row.signals).slice(0, 10),
      nextMoves: asStringList(row.nextMoves).slice(0, 8),
      rationale: String(row.rationale ?? "").trim(),
    };
  });

  const proposedPeople = asStringList(json.proposedPeople).slice(0, 16);
  const proposedWatchQueries = asStringList(json.proposedWatchQueries).slice(0, 18);
  const proposedSubSteps = asStringList(json.proposedSubSteps).slice(0, 10);
  const proposedNotes = String(json.proposedNotes ?? "").trim()
    || [
      deepBriefing.currentWork.length ? `Current work:\n- ${deepBriefing.currentWork.join("\n- ")}` : "",
      deepBriefing.alignment.length ? `Alignment:\n- ${deepBriefing.alignment.join("\n- ")}` : "",
      deepBriefing.referrals.length ? `Referrals:\n- ${deepBriefing.referrals.join("\n- ")}` : "",
      deepBriefing.events.length ? `Events:\n- ${deepBriefing.events.join("\n- ")}` : "",
    ].filter(Boolean).join("\n\n");

  if (!lenses.length && !proposedWatchQueries.length && !deepBriefing.currentWork.length) {
    throw new Error("Deep research JSON was missing the required sections.");
  }

  return {
    goalId: goal.id,
    goalTitle: goal.title,
    summary: String(json.summary ?? `Deep research for “${goal.title}” via Gemini app.`).trim(),
    pathStrategy: lenses.map((lens) => `${lens.lens} (${Math.round(lens.weight * 100)}%)`).join("; "),
    deepBriefing: deepBriefing.currentWork.length || deepBriefing.alignment.length
      ? deepBriefing
      : emptyBriefing(),
    lenses: lenses.length ? lenses : [],
    proposedWatchQueries: proposedWatchQueries.length
      ? proposedWatchQueries
      : lenses.flatMap((lens) => lens.watchQueries).slice(0, 18),
    proposedPeople: proposedPeople.length
      ? proposedPeople
      : lenses.flatMap((lens) => lens.people).slice(0, 16),
    proposedNotes,
    proposedSubSteps: proposedSubSteps.length
      ? proposedSubSteps
      : lenses.flatMap((lens) => lens.nextMoves).slice(0, 10),
    source: "gemini-app",
  };
}

/** Five specialist API agents in parallel, then merge. */
export async function researchHowToGetThere(
  goal: Goal,
  memorySummary: string,
  lifeStory = "",
): Promise<GoalResearchPlan> {
  const defaults = defaultWeights(goal.domain);

  const results = await Promise.allSettled(
    LENS_ORDER.map(async (lens) => {
      const text = await askGeminiJson(lensPrompt(lens, goal, memorySummary, lifeStory));
      return parseLens(lens, text, defaults[lens]);
    }),
  );

  const lenses: Array<LensFinding & Partial<DeepBriefing>> = [];
  for (let index = 0; index < results.length; index += 1) {
    const lens = LENS_ORDER[index];
    const result = results[index];
    if (result.status === "fulfilled") {
      lenses.push(result.value);
    } else {
      lenses.push({
        lens,
        weight: defaults[lens] * 0.4,
        people: goal.people.slice(0, 3),
        watchQueries: goal.watchQueries.slice(0, 3),
        signals: [`Could not fully research the ${lens} path automatically.`],
        nextMoves: [],
        rationale: result.reason instanceof Error ? result.reason.message : "Lens failed.",
      });
    }
  }

  if (lenses.every((lens) => !lens.watchQueries.length && !lens.people.length && !lens.nextMoves.length)) {
    throw new Error("All research agents returned empty results. Try Deep research in Gemini Pro.");
  }

  return mergePlan(goal, lenses, "api-agents");
}

/**
 * Prefer Gemini Pro app (screen macro if calibrated; otherwise copy + open).
 * Returns either a finished plan (macro path) or { needsImport, prompt }.
 */
export async function startGeminiAppDeepResearch(goal: Goal, memorySummary: string, lifeStory: string) {
  const prompt = buildDeepResearchPrompt(goal, memorySummary, lifeStory);
  const config = readScoutMacroConfig();

  if (macroIsReady(config)) {
    const reply = await runGeminiScreenMacro(prompt, {
      ...config,
      waitSeconds: Math.max(config.waitSeconds, 90),
    });
    return { mode: "done" as const, plan: parseDeepResearchPlan(reply, goal), prompt };
  }

  await launchGeminiNewsScout(prompt);
  return { mode: "needsImport" as const, plan: null, prompt };
}

export function editablePlanFrom(plan: GoalResearchPlan): GoalResearchPlan {
  return {
    ...plan,
    deepBriefing: {
      currentWork: [...plan.deepBriefing.currentWork],
      alignment: [...plan.deepBriefing.alignment],
      referrals: [...plan.deepBriefing.referrals],
      events: [...plan.deepBriefing.events],
    },
    proposedWatchQueries: [...plan.proposedWatchQueries],
    proposedPeople: [...plan.proposedPeople],
    proposedSubSteps: [...plan.proposedSubSteps],
    proposedNotes: plan.proposedNotes,
    lenses: plan.lenses.map((lens) => ({
      ...lens,
      people: [...lens.people],
      watchQueries: [...lens.watchQueries],
      signals: [...lens.signals],
      nextMoves: [...lens.nextMoves],
    })),
  };
}
