const STORAGE_KEY = "daylight-sync-key";

/** Safe Firestore document id from a passphrase / label. */
export function sanitizeSyncKey(raw: string) {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "daylight";
}

export function readSyncKey(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)?.trim();
    if (stored) return sanitizeSyncKey(stored);
  } catch {
    // ignore
  }
  const fromEnv = String(import.meta.env.VITE_DAYLIGHT_SYNC_KEY ?? "").trim();
  if (fromEnv) {
    const key = sanitizeSyncKey(fromEnv);
    writeSyncKey(key);
    return key;
  }
  const generated = `daylight-${crypto.randomUUID().slice(0, 8)}`;
  writeSyncKey(generated);
  return generated;
}

export function writeSyncKey(raw: string) {
  const key = sanitizeSyncKey(raw);
  localStorage.setItem(STORAGE_KEY, key);
  return key;
}
