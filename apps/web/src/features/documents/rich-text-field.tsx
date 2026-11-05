import { sanitiseRichText } from '@gst/domain';
import { Button } from '@gst/ui';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A small rich text box (bold, italic, bullet list) for notes and terms. What it reports is always
 * run through `sanitiseRichText`, so nothing outside the allowlist is ever stored or printed.
 */
export function RichTextField({
  label,
  value,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);

  // follow outside changes (a restored draft) without disturbing someone who is typing
  useEffect(() => {
    const el = box.current;
    // the only HTML ever assigned is the output of the allowlist sanitiser (see domain richtext tests)
    if (el && document.activeElement !== el && el.innerHTML !== value)
      el.innerHTML = sanitiseRichText(value);
  }, [value]);

  const emit = () => {
    if (box.current) onChange(sanitiseRichText(box.current.innerHTML));
  };
  const format = (command: string) => {
    box.current?.focus();
    document.execCommand(command);
    emit();
  };

  return (
    <div className="flex flex-col gap-1">
      <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {!disabled && (
        <div className="flex gap-1" role="toolbar" aria-label={t('docs.rich.toolbar', { label })}>
          {(
            [
              ['bold', 'docs.rich.bold', 'B'],
              ['italic', 'docs.rich.italic', 'I'],
              ['insertUnorderedList', 'docs.rich.list', '•'],
            ] as const
          ).map(([cmd, key, glyph]) => (
            <Button
              key={cmd}
              type="button"
              variant="outline"
              className="h-7 px-2"
              aria-label={t(key)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => format(cmd)}
            >
              {glyph}
            </Button>
          ))}
        </div>
      )}
      <div
        id={id}
        ref={box}
        role="textbox"
        aria-multiline="true"
        aria-labelledby={`${id}-label`}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-testid={testId}
        className="min-h-16 rounded-md border border-border bg-bg p-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
        onInput={emit}
        onBlur={emit}
        onPaste={(e) => {
          // paste as plain text: no foreign markup gets in at all
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
      />
    </div>
  );
}
