/**
 * Background work for offline AI: on the desktop, a watched folder of bills is read every quarter minute
 * and new files are scanned into the inbox. Renders nothing.
 */
import { useEffect, useRef } from 'react';

import { aiListDir, aiReadFile, isDesktop } from '../desktop/bridge';

import { chooseOcrEngine } from './ocr';
import { useAiRouter } from './router';
import { scanFile } from './scan';
import { useAiSettings } from './settings';

import { useAppDb } from '@/app/db';

const POLL_MS = 15_000;
const SEEN_KEY = 'ai.watch.seen';

const readSeen = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
const writeSeen = (s: Set<string>) => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500)));
  } catch {
    /* storage blocked */
  }
};

export function AiJobs() {
  const { database, ctx, business } = useAppDb();
  const settings = useAiSettings();
  const built = useAiRouter(database, ctx, business);
  const busy = useRef(false);
  const folder = settings.data?.watchFolder ?? null;
  const s = settings.data;

  useEffect(() => {
    if (!isDesktop() || !folder || !database || !ctx || !business || !s) return;
    const ocr = chooseOcrEngine(s, false);
    if (!ocr.engine) return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const files = await aiListDir(folder);
        const seen = readSeen();
        for (const f of files) {
          const key = `${folder}/${f.name}:${f.size}`;
          if (seen.has(key) || !/\.(png|jpe?g|webp|pdf)$/i.test(f.name)) continue;
          // a file still being written changes size between polls; only take it once it has settled
          seen.add(key);
          writeSeen(seen);
          try {
            const bytes = await aiReadFile(folder, f.name);
            await scanFile(
              { name: f.name, bytes },
              {
                db: database,
                ctx,
                business,
                ocr: ocr.engine,
                router: built?.router ?? null,
                languages: s.ocrLanguages,
              },
            );
          } catch {
            /* a bad file is skipped; the next one still runs */
          }
        }
      } catch {
        /* the folder may be unreachable for a while */
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const h = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(h);
    // the settings object is compared by its folder and the model state that chooses the engine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, database, ctx?.businessId, built, s?.ocr, s?.ocrModelId, s?.ocrLanguages.join(',')]);
  return null;
}
