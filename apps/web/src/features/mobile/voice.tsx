/**
 * Voice entry on a phone (prompt 43): the device's own recogniser turns speech into words, the Tier 0
 * parser (rules, with a Tier 1 or Tier 2 model where the router has one) turns the words into a draft,
 * and the draft opens as a new bill the way the desktop's voice button does. Without a device
 * recogniser the push-to-talk button (whisper, or typing) stands in.
 */
import type { DocumentType } from '@gst/domain';
import { Button, toast } from '@gst/ui';
import { Mic } from '@gst/ui/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAiRouter } from '../ai/router';
import { draftFromText } from '../ai/voice';
import { VoiceButton } from '../ai/voice-button';
import { stashVoicePrefill } from '../ai/voice-prefill';

import { useAppDb } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import i18n from '@/lib/i18n';
import { deviceSpeechSupported, listenOnce } from '@/platform/speech';

export function VoiceEntry({ type }: { type: DocumentType }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { database, ctx, business } = useAppDb();
  const built = useAiRouter(database, ctx, business);
  const [listening, setListening] = useState(false);

  if (!deviceSpeechSupported()) return <VoiceButton compact />;

  const speak = async () => {
    if (!built) return;
    setListening(true);
    try {
      const heard = await listenOnce(i18n.language);
      if (!heard.ok) {
        toast.error(
          t(heard.reason === 'unsupported' ? 'mobile.voice.unsupported' : 'mobile.voice.nothing'),
        );
        return;
      }
      const out = await draftFromText(built.router, heard.text);
      if (!out.ok) {
        toast.error(out.message ?? t('mobile.voice.failed'));
        return;
      }
      stashVoicePrefill(out.draft, out.transcript);
      toast.success(t('mobile.voice.draftReady'));
      navigate('/shop/sell', { type, voice: String(Date.now()) });
    } finally {
      setListening(false);
    }
  };

  return (
    <Button
      variant="outline"
      className="min-h-12 px-3"
      aria-label={t('mobile.voice.speak')}
      data-testid="bill-voice"
      disabled={listening || !built}
      onClick={() => void speak()}
    >
      <Mic size={20} aria-hidden className={listening ? 'animate-pulse text-danger' : ''} />
    </Button>
  );
}
