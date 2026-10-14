/** Local bundled life history (gitignored). Prefer Firebase `lifeStory` when synced. */
const bundledModules = import.meta.glob("./AUTOBIOGRAPHY.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const autobiography = String(Object.values(bundledModules)[0] ?? "");

export function getBundledLifeStory() {
  return autobiography.trim();
}

export function lifeStoryForPrompt(lifeStory: string, maxChars = 14_000) {
  const text = lifeStory.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Life story truncated for prompt size.]`;
}

export function lifeStoryLoaded() {
  return getBundledLifeStory().length > 200;
}
