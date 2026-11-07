/**
 * What the person chose for offline AI. Kept per business in `settings` (`ai.settings`), so a shared
 * computer with two books can differ. Nothing here switches on a backend by itself: the defaults are off.
 */
import { SettingsRepo, type Ctx, type Database } from '@gst/db';

import { useLiveQuery } from '@/app/db';

export type Tier1Choice = 'off' | 'builtin' | 'ollama' | 'webllm';
export type OcrChoice = 'auto' | 'sidecar' | 'tesseract';

export interface AiSettings {
  tier1: Tier1Choice;
  ollamaUrl: string;
  ollamaModel: string;
  /** Where the signed manifest is fetched from; empty uses the app's own copy. */
  manifestUrl: string;
  /** The models in use, by manifest id. */
  llmModelId: string | null;
  embedModelId: string | null;
  whisperModelId: string | null;
  ocrModelId: string | null;
  ocr: OcrChoice;
  /** Desktop: a folder of bills to scan as they arrive. */
  watchFolder: string | null;
  /** Languages the OCR engine should expect. */
  ocrLanguages: string[];
}

export const AI_SETTINGS_KEY = 'ai.settings';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  tier1: 'off',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:1.5b',
  manifestUrl: '',
  llmModelId: null,
  embedModelId: null,
  whisperModelId: null,
  ocrModelId: null,
  ocr: 'auto',
  watchFolder: null,
  ocrLanguages: ['eng', 'hin'],
};

export async function readAiSettings(d: Database, c: Ctx): Promise<AiSettings> {
  return {
    ...DEFAULT_AI_SETTINGS,
    ...((await new SettingsRepo(d).getValue<Partial<AiSettings>>(c, AI_SETTINGS_KEY)) ?? {}),
  };
}

export async function saveAiSettings(
  d: Database,
  c: Ctx,
  patch: Partial<AiSettings>,
): Promise<AiSettings> {
  const next = { ...(await readAiSettings(d, c)), ...patch };
  await new SettingsRepo(d).set(c, AI_SETTINGS_KEY, next);
  return next;
}

export function useAiSettings() {
  return useLiveQuery<AiSettings>({
    tables: ['settings'],
    key: ['ai-settings'],
    fn: readAiSettings,
  });
}
