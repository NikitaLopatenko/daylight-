import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted as isTauriPermissionGranted,
  requestPermission as requestTauriPermission,
  sendNotification as sendTauriNotification,
} from "@tauri-apps/plugin-notification";

const LAST_ALERT_KEY = "daylight-checkin-last-alert";
const ALERT_COOLDOWN_MS = 4 * 60_000;

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readLastAlert(): { id: string; at: number } {
  try {
    const raw = localStorage.getItem(LAST_ALERT_KEY);
    if (!raw) return { id: "", at: 0 };
    const parsed = JSON.parse(raw) as { id?: string; at?: number };
    return { id: String(parsed.id ?? ""), at: Number(parsed.at ?? 0) };
  } catch {
    return { id: "", at: 0 };
  }
}

function writeLastAlert(id: string, at: number) {
  localStorage.setItem(LAST_ALERT_KEY, JSON.stringify({ id, at }));
}

/** Ask OS / browser for notification permission (safe to call often). */
export async function ensureCheckInNotificationPermission(): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      let granted = await isTauriPermissionGranted();
      if (!granted) {
        const permission = await requestTauriPermission();
        granted = permission === "granted";
      }
      return granted;
    } catch {
      return false;
    }
  }

  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const permission = await Notification.requestPermission();
    return permission === "granted";
  } catch {
    return false;
  }
}

async function showOsNotification(title: string, body: string) {
  if (isTauriRuntime()) {
    try {
      const granted = await ensureCheckInNotificationPermission();
      if (!granted) return;
      sendTauriNotification({ title, body });
      return;
    } catch {
      // fall through to web API
    }
  }

  if (typeof Notification === "undefined") return;
  const granted = await ensureCheckInNotificationPermission();
  if (!granted) return;
  try {
    const note = new Notification(title, {
      body,
      tag: "daylight-checkin",
      requireInteraction: true,
    });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // ignore
  }
}

/**
 * Bring the Daylight *app window* above other apps/tabs — not just show a modal inside Daylight.
 * Desktop (Tauri) uses a native raise. Browser/PWA can only try focus + notification.
 */
export async function bringDaylightForward() {
  if (isTauriRuntime()) {
    try {
      await invoke("force_raise_main_window");
      return;
    } catch {
      // fall back to JS window APIs
    }
    try {
      const win = getCurrentWindow();
      await win.unminimize();
      await win.show();
      await win.setFocus();
      await win.setAlwaysOnTop(true);
      window.setTimeout(() => {
        void win.setAlwaysOnTop(false);
      }, 20_000);
    } catch {
      // ignore
    }
    return;
  }

  try {
    window.focus();
  } catch {
    // ignore
  }
}

/**
 * Pop the OS window forward + notification + in-app category picker.
 * Cooldown avoids spamming the same half-hour slot every poll tick.
 */
export async function alertPendingCheckIn(opts: {
  id: string;
  rangeLabel: string;
  deviceLabel: string;
  force?: boolean;
}) {
  const now = Date.now();
  const last = readLastAlert();
  if (!opts.force && last.id === opts.id && now - last.at < ALERT_COOLDOWN_MS) {
    return;
  }
  writeLastAlert(opts.id, now);

  // Raise the whole app first, then notify.
  await bringDaylightForward();
  await showOsNotification(
    "Daylight · 30-minute check-in",
    `${opts.rangeLabel} on ${opts.deviceLabel} — tap what you were doing.`,
  );
}
