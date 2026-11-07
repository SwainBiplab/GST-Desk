/**
 * The assistant (prompt 48): ask your books (answered over read-only report tools on the cloud), ask a GST
 * question (answered over the curated corpus, with sources and the not-legal-advice line), or summarise a
 * notice (a PDF or its text). Cloud only, opt-in, and nothing here changes a book.
 */
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Textarea,
  formatPaise,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CloudError,
  type AiBooksAnswer,
  type AiGstAnswer,
  type AiNoticeSummary,
} from '../cloud/client';
import { useMessaging } from '../dispatch/use-messaging';

import { useAiSettings } from './settings';

import { useConfirm } from '@/app/components/confirm';

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);
type Mode = 'books' | 'gst' | 'notice';

const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The button that opens the assistant; nothing when cloud AI is off or the book has no cloud. */
export function AssistantButton() {
  const { t } = useTranslation();
  const settings = useAiSettings();
  const cloud = useMessaging();
  const [open, setOpen] = useState(false);
  const s = settings.data;
  if (!s?.cloud.enabled || s.cloud.mode !== 'gateway' || cloud.kind !== 'ready') return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="assistant-open">
        {t('ai.assistant.open')}
      </Button>
      {open && (
        <AssistantDialog
          m={cloud.m}
          askEachTime={s.cloud.askEachTime}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AssistantDialog({
  m,
  askEachTime,
  onClose,
}: {
  m: { client: import('../cloud/client').CloudClient; orgId: string; businessId: string };
  askEachTime: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [mode, setMode] = useState<Mode>('books');
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [books, setBooks] = useState<AiBooksAnswer | null>(null);
  const [gst, setGst] = useState<AiGstAnswer | null>(null);
  const [notice, setNotice] = useState<AiNoticeSummary | null>(null);
  const [noticeText, setNoticeText] = useState('');
  const [busy, setBusy] = useState(false);

  const allowed = async () =>
    !askEachTime || confirm({ title: t('ai.cloud.askTitle'), description: t('ai.cloud.askBody') });

  const ask = async () => {
    const q = question.trim();
    if (!q || !(await allowed())) return;
    setBusy(true);
    try {
      if (mode === 'books') {
        const r = await m.client.aiAskBooks(m.orgId, {
          businessId: m.businessId,
          question: q,
          history,
        });
        setBooks(r);
        setHistory((h) =>
          [
            ...h,
            { role: 'user' as const, content: q },
            { role: 'assistant' as const, content: r.answer },
          ].slice(-10),
        );
      } else {
        setGst(await m.client.aiGstQa(m.orgId, { businessId: m.businessId, question: q }));
      }
      setQuestion('');
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const summarise = async (file: File | null) => {
    if (!(await allowed())) return;
    setBusy(true);
    try {
      const body = file
        ? {
            businessId: m.businessId,
            file: {
              name: file.name,
              mime: 'application/pdf',
              base64: toBase64(new Uint8Array(await file.arrayBuffer())),
            },
          }
        : { businessId: m.businessId, text: noticeText };
      setNotice(await m.client.aiSummariseNotice(m.orgId, body));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="assistant">
        <DialogTitle>{t('ai.assistant.title')}</DialogTitle>
        <div className="flex gap-2" role="tablist">
          {(['books', 'gst', 'notice'] as const).map((k) => (
            <Button
              key={k}
              role="tab"
              aria-selected={mode === k}
              variant={mode === k ? 'secondary' : 'ghost'}
              onClick={() => setMode(k)}
              data-testid={`assistant-mode-${k}`}
            >
              {t(`ai.assistant.modes.${k}` as never)}
            </Button>
          ))}
        </div>
        {mode !== 'notice' && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-fg-muted">
              {mode === 'books' ? t('ai.assistant.booksHelp') : t('ai.assistant.gstHelp')}
            </p>
            <div className="flex gap-2">
              <Input
                value={question}
                placeholder={t('ai.assistant.placeholder')}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void ask()}
                data-testid="assistant-question"
              />
              <Button
                onClick={() => void ask()}
                disabled={busy || !question.trim()}
                data-testid="assistant-ask"
              >
                {busy ? t('ai.assistant.busy') : t('ai.assistant.ask')}
              </Button>
            </div>
            {mode === 'books' && books && (
              <div
                className="rounded border border-border p-3 text-sm"
                data-testid="assistant-answer"
              >
                <p className="whitespace-pre-wrap">{books.answer}</p>
                {books.toolCalls.length > 0 && (
                  <p className="pt-2 text-xs text-fg-muted">
                    {t('ai.assistant.lookedAt', {
                      tools: books.toolCalls.map((c) => c.name.replaceAll('_', ' ')).join(', '),
                    })}
                  </p>
                )}
              </div>
            )}
            {mode === 'gst' && gst && (
              <div
                className="rounded border border-border p-3 text-sm"
                data-testid="assistant-answer"
              >
                <p className="whitespace-pre-wrap">{gst.answer}</p>
                {gst.sources.length > 0 && (
                  <ul className="pt-2 text-xs" data-testid="assistant-sources">
                    {gst.sources.map((src, i) => (
                      <li key={i}>
                        <a href={src.source} target="_blank" rel="noreferrer" className="underline">
                          {src.title}
                          {src.heading && src.heading !== src.title ? ` — ${src.heading}` : ''}
                        </a>{' '}
                        <span className="text-fg-muted">({src.date})</span>
                        {src.quote && <span className="block text-fg-muted">“{src.quote}”</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="pt-2 text-xs text-fg-muted" data-testid="assistant-disclaimer">
                  {gst.disclaimer}
                </p>
              </div>
            )}
          </div>
        )}
        {mode === 'notice' && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-fg-muted">{t('ai.assistant.noticeHelp')}</p>
            <input
              type="file"
              accept="application/pdf"
              data-testid="assistant-notice-file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                e.target.value = '';
                if (f) void summarise(f);
              }}
            />
            <Textarea
              rows={4}
              value={noticeText}
              placeholder={t('ai.assistant.noticePaste')}
              onChange={(e) => setNoticeText(e.target.value)}
              data-testid="assistant-notice-text"
            />
            <div>
              <Button
                onClick={() => void summarise(null)}
                disabled={busy || !noticeText.trim()}
                data-testid="assistant-summarise"
              >
                {busy ? t('ai.assistant.busy') : t('ai.assistant.summarise')}
              </Button>
            </div>
            {notice && (
              <div
                className="rounded border border-border p-3 text-sm"
                data-testid="assistant-notice"
              >
                <p className="font-medium">
                  {notice.noticeType}
                  {notice.form ? ` (${notice.form})` : ''}
                </p>
                <p className="text-xs text-fg-muted">
                  {[notice.issuedBy, notice.referenceNumber, notice.dateIssued]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className="pt-1">{notice.summary}</p>
                {notice.dueDate && (
                  <p className="pt-1">
                    <span className="font-medium">{t('ai.assistant.due')}</span> {notice.dueDate}
                  </p>
                )}
                {notice.demandPaise != null && (
                  <p>
                    <span className="font-medium">{t('ai.assistant.demand')}</span>{' '}
                    {formatPaise(notice.demandPaise)}
                  </p>
                )}
                {notice.actions.length > 0 && (
                  <ol className="list-decimal pl-5 pt-1">
                    {notice.actions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ol>
                )}
                {notice.needsProfessional && (
                  <p className="pt-1 text-warning">{t('ai.assistant.needsProfessional')}</p>
                )}
              </div>
            )}
          </div>
        )}
        <p className="text-xs text-fg-muted">{t('ai.assistant.footer')}</p>
      </DialogContent>
    </Dialog>
  );
}
