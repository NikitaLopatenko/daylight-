type VoiceMicProps = {
  listening: boolean;
  active?: boolean;
  onClick: () => void;
  label?: string;
  className?: string;
};

export function VoiceMic({
  listening,
  active = false,
  onClick,
  label = "Voice typing",
  className = "",
}: VoiceMicProps) {
  const isLive = listening && active;
  return (
    <button
      type="button"
      className={`voice-button ${isLive ? "listening" : ""} ${className}`.trim()}
      onClick={onClick}
      aria-label={isLive ? "Stop voice typing" : label}
      title={isLive ? "Stop listening" : label}
    >
      {isLive ? "■" : "🎙"}
    </button>
  );
}
