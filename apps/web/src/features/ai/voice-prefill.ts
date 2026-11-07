/**
 * A confirmed voice draft is handed to the editor the way a GSTR-2B line is: through session storage
 * for a couple of minutes. The editor looks up the party and the items by name and fills the lines; what
 * it cannot find stays as typed text for the person to fix.
 */
import type { VoiceDraft } from '@gst/ai';

const KEY = 'ai.prefill.voice';
const MAX_AGE_MS = 2 * 60_000;

export interface VoicePrefill extends VoiceDraft {
  transcript: string;
  at: number;
}

export function stashVoicePrefill(d: VoiceDraft, transcript: string, now = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...d, transcript, at: now }));
  } catch {
    /* storage blocked: the editor opens blank */
  }
}

export function peekVoicePrefill(now = Date.now()): VoicePrefill | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as VoicePrefill;
    return typeof p.at === 'number' && now - p.at <= MAX_AGE_MS ? p : null;
  } catch {
    return null;
  }
}

export function clearVoicePrefill(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
