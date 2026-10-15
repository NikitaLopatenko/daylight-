import { invoke } from "@tauri-apps/api/core";
import { openExternal } from "./openExternal";
import { GEMINI_APP_URL } from "./scout";

export type ScreenPoint = { x: number; y: number };

export type ScoutMacroConfig = {
  /** Use hardcoded screen clicks instead of manual paste */
  enabled: boolean;
  /** Also open gemini.google.com before clicking */
  openGeminiFirst: boolean;
  /** How long to wait for Gemini to finish answering */
  waitSeconds: number;
  points: {
    /** Pinned Daylight news chat in the left sidebar */
    chat: ScreenPoint | null;
    /** Message input box at the bottom */
    input: ScreenPoint | null;
    /** Area of the latest model reply to select/copy */
    response: ScreenPoint | null;
  };
};

const STORAGE_KEY = "daylight-scout-macro";

export const defaultScoutMacroConfig = (): ScoutMacroConfig => ({
  enabled: false,
  openGeminiFirst: true,
  waitSeconds: 45,
  points: {
    chat: null,
    input: null,
    response: null,
  },
});

export function readScoutMacroConfig(): ScoutMacroConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ScoutMacroConfig> | null;
    if (!raw) return defaultScoutMacroConfig();
    const base = defaultScoutMacroConfig();
    return {
      enabled: Boolean(raw.enabled),
      openGeminiFirst: raw.openGeminiFirst !== false,
      waitSeconds: Math.max(5, Number(raw.waitSeconds) || base.waitSeconds),
      points: {
        chat: raw.points?.chat ?? null,
        input: raw.points?.input ?? null,
        response: raw.points?.response ?? null,
      },
    };
  } catch {
    return defaultScoutMacroConfig();
  }
}

export function writeScoutMacroConfig(config: ScoutMacroConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function macroIsReady(config: ScoutMacroConfig) {
  return Boolean(config.enabled && config.points.chat && config.points.input && config.points.response);
}

async function sleep(ms: number) {
  await invoke("sleep_ms", { ms });
}

export async function getCursorPosition() {
  return invoke<ScreenPoint>("get_cursor_position");
}

/** Countdown, then capture wherever the mouse is. Hover the target before it finishes. */
export async function capturePointAfterCountdown(
  seconds: number,
  onTick?: (left: number) => void,
): Promise<ScreenPoint> {
  for (let left = seconds; left > 0; left -= 1) {
    onTick?.(left);
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  onTick?.(0);
  return getCursorPosition();
}

export async function runGeminiScreenMacro(prompt: string, config: ScoutMacroConfig): Promise<string> {
  if (!macroIsReady(config)) {
    throw new Error("Calibrate chat, input, and response points first, then enable the macro.");
  }

  const chat = config.points.chat!;
  const input = config.points.input!;
  const response = config.points.response!;

  await invoke("clipboard_write", { text: prompt });

  if (config.openGeminiFirst) {
    await openExternal(GEMINI_APP_URL);
    await sleep(2500);
  }

  await invoke("click_at", { x: chat.x, y: chat.y });
  await sleep(700);
  await invoke("click_at", { x: input.x, y: input.y });
  await sleep(400);
  await invoke("send_hotkey", { action: "ctrl+v" });
  await sleep(350);
  await invoke("send_hotkey", { action: "enter" });

  await sleep(config.waitSeconds * 1000);

  await invoke("click_at", { x: response.x, y: response.y });
  await sleep(250);
  await invoke("send_hotkey", { action: "ctrl+a" });
  await sleep(200);
  await invoke("send_hotkey", { action: "ctrl+c" });
  await sleep(300);

  const text = await invoke<string>("clipboard_read");
  if (!text.trim()) throw new Error("Clipboard was empty after copy. Recalibrate the response point or raise wait time.");
  return text;
}
