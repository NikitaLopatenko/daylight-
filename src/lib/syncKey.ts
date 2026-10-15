const STORAGE_KEY = "daylight-sync-key";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5; // 5 years

/** Safe Firestore document id from a passphrase / label. */
export function sanitizeSyncKey(raw: string) {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "daylight";
}

function readCookie(name: string) {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function writeCookie(name: string, value: string) {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  } catch {
    // ignore
  }
}

/** One-time: https://daylight-fc0c2.web.app/?vault=your-key — then strip from the address bar. */
export function bootstrapSyncKeyFromUrl() {
  try {
    const url = new URL(window.location.href);
    const vault = url.searchParams.get("vault") || url.searchParams.get("key");
    if (!vault?.trim()) return null;
    const key = writeSyncKey(vault);
    url.searchParams.delete("vault");
    url.searchParams.delete("key");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", next);
    return key;
  } catch {
    return null;
  }
}

export function readSyncKey(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)?.trim();
    if (stored) {
      const key = sanitizeSyncKey(stored);
      writeCookie(STORAGE_KEY, key);
      return key;
    }
  } catch {
    // ignore
  }

  const fromCookie = readCookie(STORAGE_KEY).trim();
  if (fromCookie) {
    const key = sanitizeSyncKey(fromCookie);
    try { localStorage.setItem(STORAGE_KEY, key); } catch { /* ignore */ }
    return key;
  }

  const fromEnv = String(import.meta.env.VITE_DAYLIGHT_SYNC_KEY ?? "").trim();
  if (fromEnv) {
    return writeSyncKey(fromEnv);
  }

  // Last resort only — avoid inventing a new random key on every cold phone visit.
  // Prefer env / cookie / pasted key instead.
  const generated = `daylight-${crypto.randomUUID().slice(0, 8)}`;
  return writeSyncKey(generated);
}

export function writeSyncKey(raw: string) {
  const key = sanitizeSyncKey(raw);
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // ignore
  }
  writeCookie(STORAGE_KEY, key);
  return key;
}
