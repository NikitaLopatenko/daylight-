import { PointerEvent, useRef, useState } from "react";
import {
  formatClock,
  sleepDurationHours,
  sleepTimelinePercent,
  sleepTimelineTime,
  sleepWindowSegments,
} from "./journal";

type SleepTimelineProps = {
  start: string;
  end: string;
  onChange?: (start: string, end: string) => void;
  interactive?: boolean;
  compact?: boolean;
};

type Handle = "start" | "end";

export function SleepTimeline({
  start,
  end,
  onChange,
  interactive = false,
  compact = false,
}: SleepTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Handle | null>(null);

  function percentFromClientX(clientX: number) {
    const track = trackRef.current;
    if (!track) return 0;
    const bounds = track.getBoundingClientRect();
    if (bounds.width <= 0) return 0;
    return ((clientX - bounds.left) / bounds.width) * 100;
  }

  function updateHandle(handle: Handle, clientX: number) {
    if (!onChange) return;
    const nextTime = sleepTimelineTime(percentFromClientX(clientX));
    if (handle === "start") onChange(nextTime, end);
    else onChange(start, nextTime);
  }

  function beginDrag(handle: Handle, event: PointerEvent<HTMLButtonElement>) {
    if (!interactive || !onChange) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(handle);
    updateHandle(handle, event.clientX);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragging) return;
    updateHandle(dragging, event.clientX);
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(null);
  }

  function jumpNearest(event: PointerEvent<HTMLDivElement>) {
    if (!interactive || !onChange || dragging) return;
    const percent = percentFromClientX(event.clientX);
    const startDistance = Math.abs(percent - sleepTimelinePercent(start));
    const endDistance = Math.abs(percent - sleepTimelinePercent(end));
    updateHandle(startDistance <= endDistance ? "start" : "end", event.clientX);
  }

  const startPos = sleepTimelinePercent(start);
  const endPos = sleepTimelinePercent(end);

  return (
    <div className={`sleep-timeline ${compact ? "compact" : ""} ${interactive ? "interactive" : ""}`}>
      <div
        className="sleep-track"
        ref={trackRef}
        onPointerDown={jumpNearest}
        role={interactive ? "slider" : undefined}
        aria-label="Sleep window"
      >
        {sleepWindowSegments(start, end).map((segment, index) => (
          <span
            className="sleep-span"
            key={`span-${index}`}
            style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
          />
        ))}
        {interactive && (
          <>
            <button
              type="button"
              className={`sleep-handle start ${dragging === "start" ? "active" : ""}`}
              style={{ left: `${startPos}%` }}
              aria-label={`Fell asleep at ${formatClock(start)}`}
              onPointerDown={(event) => beginDrag("start", event)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <em>{formatClock(start)}</em>
            </button>
            <button
              type="button"
              className={`sleep-handle end ${dragging === "end" ? "active" : ""}`}
              style={{ left: `${endPos}%` }}
              aria-label={`Woke up at ${formatClock(end)}`}
              onPointerDown={(event) => beginDrag("end", event)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <em>{formatClock(end)}</em>
            </button>
          </>
        )}
      </div>
      <div className="sleep-scale">
        <span>12p</span><span>6p</span><span>12a</span><span>6a</span><span>12p</span>
      </div>
      {!compact && (
        <p className="sleep-summary">
          {formatClock(start)} → {formatClock(end)} · {sleepDurationHours(start, end)} hours
          {interactive ? " · drag the points or type times above" : ""}
        </p>
      )}
    </div>
  );
}
