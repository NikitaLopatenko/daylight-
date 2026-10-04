# Daylight

A calm Windows desktop day planner built with Tauri 2, React, and TypeScript.

## Current prototype

- Daily checklist with quick capture and local persistence
- Habit tracker, points, and daily progress
- Schedule, smart-suggestion, and birthday surfaces
- Starts automatically after the first native launch
- Closing the window hides it to the Windows tray

Google Calendar, Gmail, notifications, and AI suggestions are intentionally
reserved for the next integration phase. The current example schedule and
birthday are placeholder data.

## Run

```powershell
npm install
npm run tauri dev
```

The first native compilation can take several minutes. Use `npm run dev` for a
fast browser-only UI preview.
