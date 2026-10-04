type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechErrorEvent = {
  error: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export type VoiceSession = {
  stop: () => void;
};

type VoiceInputOptions = {
  onTranscript: (transcript: string) => void;
  onEnd: () => void;
  onError: (message: string) => void;
};

export function startVoiceInput(options: VoiceInputOptions): VoiceSession | null {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  let finalTranscript = "";

  recognition.onresult = (event) => {
    let interimTranscript = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0]?.transcript ?? "";
      if (result.isFinal) finalTranscript += `${transcript} `;
      else interimTranscript += transcript;
    }

    options.onTranscript(`${finalTranscript}${interimTranscript}`.trim());
  };

  recognition.onerror = (event) => {
    const messages: Record<string, string> = {
      "audio-capture": "No microphone was found. Check Windows microphone settings.",
      "not-allowed": "Microphone access was blocked. Allow it in Windows privacy settings.",
      network: "Voice recognition needs a network connection on this device.",
      "no-speech": "I didn’t hear anything. Try the microphone again.",
    };
    options.onError(messages[event.error] ?? `Voice recognition stopped: ${event.error}.`);
  };

  recognition.onend = options.onEnd;

  try {
    recognition.start();
  } catch {
    return null;
  }

  return {
    stop: () => recognition.stop(),
  };
}
