import { Button, toast } from '@gst/ui';
import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { MAX_IMAGES, type ImageRef } from './form';

import { getBlob, putBlob, resizeImage } from '@/app/blobs';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** An object URL for a stored picture, released when it is no longer shown. */
function useImageUrl(ref: ImageRef): string | null {
  const [state, setState] = useState<{ path: string; href: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    void getBlob(ref.storagePath, ref.mime).then((blob) => {
      if (cancelled) return;
      made = blob ? URL.createObjectURL(blob) : null;
      setState({ path: ref.storagePath, href: made });
    });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [ref.storagePath, ref.mime]);
  return state?.path === ref.storagePath ? state.href : null;
}

function Thumb({ image, onRemove }: { image: ImageRef; onRemove: () => void }) {
  const { t } = useTranslation();
  const href = useImageUrl(image);
  return (
    <li className="flex flex-col items-center gap-1" data-testid="item-image">
      <span className="flex size-16 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2">
        {href && <img src={href} alt={image.name} className="size-full object-cover" />}
      </span>
      <Button
        type="button"
        variant="ghost"
        aria-label={`${t('items.images.remove')} ${image.name}`}
        onClick={onRemove}
      >
        {t('items.images.remove')}
      </Button>
    </li>
  );
}

/**
 * Up to five pictures per item. Each file is decoded (so only real images are accepted), scaled to
 * at most 512 px and stored by its hash; the item keeps a small reference.
 */
export function ItemImages({
  value,
  onChange,
}: {
  value: ImageRef[];
  onChange: (images: ImageRef[]) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const add = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length === 0) return;
    setBusy(true);
    const next = [...value];
    try {
      for (const file of files) {
        if (next.length >= MAX_IMAGES) {
          toast.error(t('items.images.tooMany', { max: MAX_IMAGES }));
          break;
        }
        if (file.size > MAX_FILE_BYTES) {
          toast.error(t('items.images.tooBig', { name: file.name }));
          continue;
        }
        try {
          const stored = await putBlob(await resizeImage(file, 512));
          if (!next.some((i) => i.sha256 === stored.sha256))
            next.push({
              sha256: stored.sha256,
              mime: stored.mime,
              storagePath: stored.storagePath,
              name: file.name,
            });
        } catch {
          toast.error(t('items.images.invalid', { name: file.name }));
        }
      }
      onChange(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 text-sm font-medium">{t('items.images.title')}</legend>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-3" aria-label={t('items.images.title')}>
          {value.map((image) => (
            <Thumb
              key={image.sha256}
              image={image}
              onRemove={() => onChange(value.filter((i) => i.sha256 !== image.sha256))}
            />
          ))}
        </ul>
      )}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        aria-label={t('items.images.add')}
        data-testid="item-image-input"
        disabled={busy || value.length >= MAX_IMAGES}
        onChange={(e) => void add(e)}
        className="text-sm"
      />
      <p className="text-xs text-fg-muted">{t('items.images.help', { max: MAX_IMAGES })}</p>
    </fieldset>
  );
}
