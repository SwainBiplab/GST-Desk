/**
 * Scan a bill from the phone (prompt 43): the camera (or a file on the web), made smaller on the device,
 * read by the OCR and the rules here, into the inbox. The model step runs on the phone only when the
 * device can (WebGPU and a capable class); otherwise the item is marked for a desktop with a local
 * model, or the cloud (prompt 48), to finish. Nothing here waits for the network.
 */
import { classify, detectBrowserHardware } from '@gst/ai';
import { toast } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { chooseOcrEngine } from '../ai/ocr';
import { useAiRouter } from '../ai/router';
import { scanFile } from '../ai/scan';
import { useAiSettings } from '../ai/settings';

import { tier1OnPhone } from './logic';

import { DEMO_REQUESTED, useAppDb } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import { isNativeApp } from '@/platform';
import { captureBill, fromFile, type Captured } from '@/platform/camera';

export function useScanBill() {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const navigate = useAppNavigate();
  const settings = useAiSettings();
  const built = useAiRouter(database, ctx, business);
  const [busy, setBusy] = useState(false);

  const run = async (file: Captured) => {
    if (!database || !ctx || !business || !settings.data) return;
    const ocr = chooseOcrEngine(settings.data, DEMO_REQUESTED);
    if (!ocr.engine) {
      toast.error(t('ai.scan.noOcr'));
      return;
    }
    const hw = detectBrowserHardware(navigator);
    const modelHere = tier1OnPhone({ deviceClass: classify(hw), webgpu: 'gpu' in navigator });
    setBusy(true);
    try {
      const out = await scanFile(
        { name: file.name, bytes: file.bytes },
        {
          db: database,
          ctx,
          business,
          ocr: ocr.engine,
          router: modelHere ? (built?.router ?? null) : null,
          languages: settings.data.ocrLanguages,
          deferModel: !modelHere,
        },
      );
      toast.success(t(modelHere ? 'ai.scan.done' : 'mobile.scan.deferred', { count: 1 }));
      navigate('/shop/inbox', { item: out.reviewItemId });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    if (isNativeApp()) {
      const shot = await captureBill();
      if (shot) await run(shot);
      return;
    }
    // the web: a file chooser made for this one tap
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = 'image/png,image/jpeg,image/webp,application/pdf';
    el.setAttribute('data-testid', 'mobile-scan-input');
    el.onchange = () => {
      const f = el.files?.[0];
      if (f) void fromFile(f).then(run);
    };
    el.click();
  };

  /** The OCR settings and the router are read before the first tap can do anything. */
  return { scan, busy, ready: !!settings.data && !!database && !!ctx };
}
