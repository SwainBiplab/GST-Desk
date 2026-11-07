/**
 * The device's own speech recogniser (prompt 43): Android's through Capacitor, the browser's where it
 * has one. The words come back as text; turning them into a draft is the Tier 0 parser's job
 * (`features/ai/voice.ts`), with a Tier 1 or Tier 2 model where one is available.
 */
import { hasPlugin } from './index';

export type Heard = { ok: true; text: string } | { ok: false; reason: 'unsupported' | 'nothing' };

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

const browserRecognition = (): (new () => RecognitionLike) | null => {
  const g = globalThis as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
};

export function deviceSpeechSupported(): boolean {
  return hasPlugin('SpeechRecognition') || browserRecognition() !== null;
}

/** Languages the recogniser is asked for, from the app's language. */
export const speechLocale = (lang: string): string =>
  (({ hi: 'hi-IN', ta: 'ta-IN', mr: 'mr-IN', bn: 'bn-IN', gu: 'gu-IN' }) as Record<string, string>)[
    lang.slice(0, 2)
  ] ?? 'en-IN';

export async function listenOnce(lang: string): Promise<Heard> {
  if (hasPlugin('SpeechRecognition')) {
    const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
    const { available } = await SpeechRecognition.available();
    if (!available) return { ok: false, reason: 'unsupported' };
    const perm = await SpeechRecognition.requestPermissions();
    if (perm.speechRecognition !== 'granted') return { ok: false, reason: 'nothing' };
    const r = await SpeechRecognition.start({
      language: speechLocale(lang),
      maxResults: 1,
      partialResults: false,
      popup: true,
    });
    const text = r.matches?.[0]?.trim() ?? '';
    return text ? { ok: true, text } : { ok: false, reason: 'nothing' };
  }
  const Rec = browserRecognition();
  if (!Rec) return { ok: false, reason: 'unsupported' };
  return new Promise<Heard>((resolve) => {
    const rec = new Rec();
    rec.lang = speechLocale(lang);
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let done = false;
    const finish = (h: Heard) => {
      if (done) return;
      done = true;
      resolve(h);
    };
    rec.onresult = (e) => finish({ ok: true, text: String(e.results[0]?.[0]?.transcript ?? '') });
    rec.onerror = () => finish({ ok: false, reason: 'nothing' });
    rec.onend = () => finish({ ok: false, reason: 'nothing' });
    rec.start();
  });
}
