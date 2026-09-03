const CLASSIC_POKER_ACTION = /^(?:小盲 \d+|大盲 \d+|弃牌|过牌|跟注 \d+(?:，全押)?|下注(?:至)? \d+(?:，全押)?|加注至 \d+(?:，全押)?|全押(?:至)? \d+)$/;

function cleanSpeechText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function actionLogEntryKey(entry) {
  return [entry?.at, entry?.actor, entry?.text].map(cleanSpeechText).join("|");
}

export function actionVoiceAnnouncement(entry) {
  const actor = cleanSpeechText(entry?.actor);
  const text = cleanSpeechText(entry?.text);
  if (!actor || !CLASSIC_POKER_ACTION.test(text)) return "";
  return actor ? `${actor}，${text}` : text;
}

export function browserSpeechAvailable(scope = globalThis) {
  return Boolean(scope?.speechSynthesis && scope?.SpeechSynthesisUtterance);
}

function preferredMandarinVoice(synthesis) {
  const voices = synthesis?.getVoices?.() ?? [];
  return voices.find((voice) => /^zh[-_](CN|Hans)/i.test(voice.lang))
    ?? voices.find((voice) => /^zh/i.test(voice.lang))
    ?? null;
}

export function speakVoiceAnnouncement(text, options = {}) {
  const scope = options.scope ?? globalThis;
  if (!browserSpeechAvailable(scope)) return false;
  const message = cleanSpeechText(text);
  if (!message) return false;

  try {
    const synthesis = scope.speechSynthesis;
    if (options.interrupt) synthesis.cancel();
    const utterance = new scope.SpeechSynthesisUtterance(message);
    utterance.lang = "zh-CN";
    utterance.rate = 0.96;
    utterance.pitch = 1;
    utterance.volume = 0.9;
    const voice = preferredMandarinVoice(synthesis);
    if (voice) utterance.voice = voice;
    synthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

export function cancelVoiceAnnouncements(scope = globalThis) {
  try {
    scope?.speechSynthesis?.cancel?.();
  } catch {
    // Speech is optional; a browser voice failure must never interrupt the table.
  }
}
