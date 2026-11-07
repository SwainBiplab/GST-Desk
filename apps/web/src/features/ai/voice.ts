/**
 * Push-to-talk: record while the button is held, turn the recording into 16 kHz mono WAV (what
 * whisper.cpp reads), transcribe through the router, and parse the words into a draft. The draft is
 * shown for confirmation; nothing is created until the person says so.
 */
import { voiceDraftSchema, type AiRouter, type VoiceDraft } from '@gst/ai';

export interface Recording {
  stop: () => Promise<Blob>;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        };
        rec.stop();
      }),
  };
}

/** Decode whatever the browser recorded and write 16 kHz 16-bit mono PCM WAV. */
export async function toWav16k(blob: Blob): Promise<Uint8Array> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16_000;
    const frames = Math.ceil(decoded.duration * rate || 0);
    const offline = new OfflineAudioContext(1, Math.max(1, frames), rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const out = await offline.startRendering();
    const pcm = out.getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (at: number, s: string) =>
      [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + pcm.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]!));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  } finally {
    await ctx.close();
  }
}

export type VoiceOutcome =
  | { ok: true; transcript: string; draft: VoiceDraft; confidence: number; provider: string }
  | { ok: false; reason: 'no_speech_model' | 'nothing_heard' | 'failed'; message?: string };

/** Transcribe, then parse. Hindi, Hinglish, Tamil and Marathi are fine: whisper detects the language. */
export async function speechToDraft(
  router: AiRouter,
  wav: Uint8Array,
  language?: string,
): Promise<VoiceOutcome> {
  const t = await router.transcribe(
    { bytes: wav, mime: 'audio/wav' },
    { feature: 'voice_transcribe', ...(language ? { language } : {}) },
  );
  if (!t.ok)
    return {
      ok: false,
      reason:
        t.error.code === 'no_provider' || t.error.code === 'unsupported'
          ? 'no_speech_model'
          : 'failed',
      message: t.error.message,
    };
  const transcript = t.value.text.trim();
  if (!transcript) return { ok: false, reason: 'nothing_heard' };
  return draftFromText(router, transcript);
}

/** The parse step on its own, so a typed sentence works the same as a spoken one. */
export async function draftFromText(router: AiRouter, transcript: string): Promise<VoiceOutcome> {
  const d = await router.suggest(
    { feature: 'voice_draft', text: transcript, input: { text: transcript } },
    voiceDraftSchema,
    { schemaName: 'voiceDraft' },
  );
  if (!d.ok) return { ok: false, reason: 'failed', message: d.error.message };
  return { ok: true, transcript, draft: d.value, confidence: d.confidence, provider: d.provider };
}
