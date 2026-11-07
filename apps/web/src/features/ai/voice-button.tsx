/**
 * Push-to-talk. Hold the button (or Space while it has focus) and speak; let go and the words become a
 * draft shown for confirmation. The sentence can also be typed, which is how a computer without a
 * microphone, or a test, uses the same path.
 */
import type { VoiceDraft } from '@gst/ai';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  Textarea,
  formatPaise,
} from '@gst/ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAiRouter } from './router';
import {
  draftFromText,
  speechToDraft,
  startRecording,
  toWav16k,
  type Recording,
  type VoiceOutcome,
} from './voice';
import { stashVoicePrefill } from './voice-prefill';

import { useAppDb } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import { useAppStore } from '@/app/store';
import { track } from '@/features/telemetry/telemetry';

type State = 'idle' | 'recording' | 'working';

export function VoiceButton({
  compact = false,
  onClose,
}: {
  compact?: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const built = useAiRouter(database, ctx, business);
  const [state, setState] = useState<State>('idle');
  const [outcome, setOutcome] = useState<VoiceOutcome | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);
  const canRecord = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const begin = async () => {
    if (state !== 'idle' || !canRecord) return;
    try {
      rec.current = await startRecording();
      setState('recording');
    } catch {
      setOutcome({ ok: false, reason: 'failed', message: t('ai.voice.noMic') });
    }
  };
  const end = async () => {
    const r = rec.current;
    rec.current = null;
    if (!r || state !== 'recording') return;
    setState('working');
    try {
      const blob = await r.stop();
      const wav = await toWav16k(blob);
      if (!built) return setOutcome({ ok: false, reason: 'failed' });
      setOutcome(await speechToDraft(built.router, wav));
      track('ai_voice');
    } finally {
      setState('idle');
    }
  };
  const parseTyped = async (text: string) => {
    if (!built || !text.trim()) return;
    setState('working');
    try {
      setOutcome(await draftFromText(built.router, text.trim()));
      setTyping(null);
    } finally {
      setState('idle');
    }
  };

  return (
    <>
      <span className="inline-flex items-center gap-1">
        <Button
          variant={state === 'recording' ? 'primary' : 'secondary'}
          aria-pressed={state === 'recording'}
          aria-label={t('ai.voice.hold')}
          title={canRecord ? t('ai.voice.hold') : t('ai.voice.noMic')}
          data-testid="voice-button"
          data-state={state}
          disabled={state === 'working' || !built}
          onPointerDown={(e) => {
            e.preventDefault();
            void begin();
          }}
          onPointerUp={() => void end()}
          onPointerLeave={() => void end()}
          onKeyDown={(e) => {
            if (e.key === ' ' && state === 'idle') {
              e.preventDefault();
              void begin();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === ' ') void end();
          }}
        >
          {state === 'recording'
            ? t('ai.voice.listening')
            : state === 'working'
              ? t('ai.voice.working')
              : compact
                ? t('ai.voice.short')
                : t('ai.voice.button')}
        </Button>
        <Button
          variant="ghost"
          aria-label={t('ai.voice.type')}
          data-testid="voice-type"
          disabled={!built}
          onClick={() => setTyping('')}
        >
          {t('ai.voice.typeShort')}
        </Button>
      </span>
      {typing !== null && (
        <AlertDialog open onOpenChange={(o) => !o && setTyping(null)}>
          <AlertDialogContent data-testid="voice-type-dialog">
            <AlertDialogTitle>{t('ai.voice.type')}</AlertDialogTitle>
            <AlertDialogDescription>{t('ai.voice.typeHelp')}</AlertDialogDescription>
            <Textarea
              rows={3}
              value={typing}
              data-testid="voice-text"
              onChange={(e) => setTyping(e.target.value)}
            />
            <div className="flex justify-end gap-2 pt-3">
              <Button variant="ghost" onClick={() => setTyping(null)}>
                {t('confirm.cancel')}
              </Button>
              <Button
                data-testid="voice-parse"
                disabled={state === 'working'}
                onClick={() => void parseTyped(typing)}
              >
                {t('ai.voice.parse')}
              </Button>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {outcome && (
        <VoiceDraftDialog
          outcome={outcome}
          onClose={() => {
            setOutcome(null);
            onClose?.();
          }}
        />
      )}
    </>
  );
}

function VoiceDraftDialog({ outcome, onClose }: { outcome: VoiceOutcome; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const shell = useAppStore((s) => s.shell);
  const go = (d: VoiceDraft, transcript: string) => {
    stashVoicePrefill(d, transcript);
    onClose();
    if (d.intent === 'payment')
      navigate(
        `/${shell}/payments`,
        d.amountPaise !== null && d.party
          ? { cmd: `received ${d.amountPaise / 100} from ${d.party}` }
          : {},
      );
    else if (d.intent === 'purchase')
      navigate(shell === 'shop' ? '/shop/sell' : '/books/documents/new', {
        type: 'purchase_bill',
        voice: String(Date.now()),
      });
    else
      navigate(shell === 'shop' ? '/shop/sell' : '/books/documents/new', {
        voice: String(Date.now()),
      });
  };
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="voice-dialog">
        <AlertDialogTitle>{t('ai.voice.heard')}</AlertDialogTitle>
        {outcome.ok ? (
          <>
            <AlertDialogDescription>
              <span className="italic" data-testid="voice-transcript">
                “{outcome.transcript}”
              </span>
            </AlertDialogDescription>
            <dl
              className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 py-2 text-sm"
              data-testid="voice-draft"
            >
              <dt className="text-fg-muted">{t('ai.voice.intent')}</dt>
              <dd>{t(`ai.voice.intents.${outcome.draft.intent}` as never)}</dd>
              <dt className="text-fg-muted">{t('ai.voice.party')}</dt>
              <dd data-testid="voice-party">{outcome.draft.party ?? '—'}</dd>
              {outcome.draft.amountPaise !== null && (
                <>
                  <dt className="text-fg-muted">{t('ai.voice.amount')}</dt>
                  <dd>{formatPaise(outcome.draft.amountPaise)}</dd>
                </>
              )}
            </dl>
            {outcome.draft.lines.length > 0 && (
              <ul className="text-sm" data-testid="voice-lines">
                {outcome.draft.lines.map((l, i) => (
                  <li key={i}>
                    {`${l.qty}${l.unit ? ` ${l.unit}` : ''} × ${l.description}${l.ratePaise !== null ? ` @ ${formatPaise(l.ratePaise)}` : ''}`}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-fg-muted">
              {t('ai.voice.confirmNote', { confidence: Math.round(outcome.confidence * 100) })}
            </p>
            <div className="flex justify-end gap-2 pt-3">
              <Button variant="ghost" onClick={onClose}>
                {t('confirm.cancel')}
              </Button>
              <Button
                data-testid="voice-create"
                onClick={() => go(outcome.draft, outcome.transcript)}
              >
                {t('ai.voice.create')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <AlertDialogDescription data-testid="voice-failed">
              {t(`ai.voice.errors.${outcome.reason}` as never, { message: outcome.message ?? '' })}
            </AlertDialogDescription>
            <div className="flex justify-end pt-3">
              <Button onClick={onClose}>{t('confirm.ok')}</Button>
            </div>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
