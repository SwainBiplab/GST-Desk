import type { DocumentType } from '@gst/domain';
import { useState } from 'react';

import { adoptedIds } from './adopt';
import { EditorPage } from './editor-page';
import { defaultSaleFor } from './use-editor';

import { useAppDb } from '@/app/db';
import { useLocationInfo } from '@/app/hooks';
import type { Shell } from '@/app/store';

const TYPES: readonly DocumentType[] = [
  'tax_invoice',
  'bill_of_supply',
  'proforma',
  'quotation',
  'credit_note',
  'debit_note',
  'delivery_challan',
  'purchase_bill',
  'purchase_return',
  'expense',
];

interface Mounted {
  id: string | null;
  type: DocumentType;
  /** Counts mounts, so the same address opened again is a fresh editor. */
  n: number;
  voice: string;
}

/**
 * Reads `?type=` and `?id=` from the address and opens the editor.
 *
 * A new document gets its id on the first autosave, and the editor writes that id into the address so
 * a reload comes back to it. That must not restart the editor, so an id the editor adopted itself keeps
 * the same mounted editor. Any other change of address (a converted or duplicated document, another
 * draft) opens a fresh editor.
 */
export function EditorRoute({ shell }: { shell: Shell }) {
  const { search } = useLocationInfo();
  const { business, ctx } = useAppDb();
  const id = typeof search['id'] === 'string' ? search['id'] : null;
  // a spoken draft arrives with a fresh `voice` stamp, so the same address opens a new editor for it
  const voice = typeof search['voice'] === 'string' ? search['voice'] : '';
  const asked =
    typeof search['type'] === 'string'
      ? search['type']
      : typeof search['kind'] === 'string'
        ? search['kind']
        : '';
  const type = (TYPES as readonly string[]).includes(asked)
    ? (asked as DocumentType)
    : defaultSaleFor(business);

  const [m, setM] = useState<Mounted>({ id, type, n: 0, voice });
  const adopted = m.id === null && id !== null && adoptedIds.has(id);
  // adjusting state while rendering is React's way to reset on a changed input
  if (adopted) setM({ ...m, id });
  else if (m.id !== id || (id === null && (m.type !== type || m.voice !== voice)))
    setM({ id, type, n: m.n + 1, voice });

  if (!ctx || !business) return <p className="p-4 text-fg-muted">...</p>;
  return <EditorPage key={`${shell}:${m.n}`} shell={shell} type={m.type} id={m.id} />;
}
