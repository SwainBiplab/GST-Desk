import {
  SCRIPT_NAMES,
  languageOfScript,
  latinKeyOf,
  scriptOf,
  suggest,
  type Script,
} from '@gst/i18n';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Textarea,
  cn,
} from '@gst/ui';
import { Languages } from '@gst/ui/icons';
import { useId, useState, type ComponentProps, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

const SCRIPT_KEY = 'gst.translit.script';
const SCRIPTS: Script[] = ['deva', 'tamil', 'bengali', 'gujarati'];
const OFF = 'off';

function storedChoice(): Script | typeof OFF | null {
  try {
    const v = localStorage.getItem(SCRIPT_KEY);
    return v === OFF ? OFF : SCRIPTS.includes(v as Script) ? (v as Script) : null;
  } catch {
    return null;
  }
}

function remember(v: Script | typeof OFF) {
  try {
    localStorage.setItem(SCRIPT_KEY, v);
  } catch {
    /* storage may be blocked */
  }
}

/** The typing language a field starts in: the last one chosen on this device, else the language of the screens. */
export function startScript(uiLanguage: string): Script | null {
  const stored = storedChoice();
  if (stored === OFF) return null;
  return stored ?? scriptOf(uiLanguage);
}

/** The Roman word being typed at the end of the text, if any. */
const trailingWord = (text: string) => /[A-Za-z]+$/.exec(text)?.[0] ?? '';

type FieldProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'>;

export interface TranslitInputProps extends FieldProps {
  value: string;
  /** Called with the new text and the Roman key to keep for search (empty when the text is Roman). */
  onValueChange: (value: string, latin: string) => void;
  /** A multi-line field (notes). */
  multiline?: boolean;
  /** Visible lines of a multi-line field. */
  rows?: number;
}

/**
 * A text field that turns Roman letters into an Indian script as a person types. Typing "sharma" offers
 * शर्मा and its neighbours under the field; Space or Enter takes the highlighted one, Up and Down choose,
 * Escape keeps the letters as typed. A button beside the field switches the script (or turns it off).
 * The field keeps the native text, and reports the Roman text typed as a search key, so the name is
 * found by either.
 */
export function TranslitInput({
  value,
  onValueChange,
  multiline = false,
  className,
  ...rest
}: TranslitInputProps) {
  const { t, i18n } = useTranslation();
  const [script, setScript] = useState<Script | null>(() => startScript(i18n.language));
  /** Native word to the Roman word it came from, for this visit to the field. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const listId = useId();

  const word = script ? trailingWord(value) : '';
  const options = script && word && dismissed !== word ? suggest(word, script) : [];
  const open = options.length > 0;
  const active = Math.min(choice, Math.max(options.length - 1, 0));

  const emit = (text: string, map = typed) => onValueChange(text, latinKeyOf(text, map));

  const take = (index: number, tail = '') => {
    const native = options[index];
    if (!native || !word) return false;
    const next = { ...typed, [native]: word };
    setTyped(next);
    setChoice(0);
    emit(value.slice(0, value.length - word.length) + native + tail, next);
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setChoice((active + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setChoice((active - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
      // taking a spelling is not submitting the form
      e.preventDefault();
      take(active);
    } else if (e.key === ' ') {
      // take the spelling and let the space be typed after it
      e.preventDefault();
      take(active, ' ');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(word);
    }
  };

  const common = {
    ...rest,
    value,
    className,
    lang: script ? languageOfScript(script) : undefined,
    role: script ? 'combobox' : undefined,
    'aria-expanded': script ? open : undefined,
    'aria-controls': script && open ? listId : undefined,
    'aria-autocomplete': script ? ('list' as const) : undefined,
    'aria-activedescendant': script && open ? `${listId}-${active}` : undefined,
    onKeyDown,
    onBlur: () => {
      // never leave a word half-typed: take the first spelling when the field loses focus
      if (open) take(0);
    },
  };

  const change = (text: string) => {
    setDismissed('');
    setChoice(0);
    emit(text);
  };

  return (
    <div className="relative flex items-start gap-1">
      <div className="relative min-w-0 flex-1">
        {multiline ? (
          <Textarea
            {...(common as ComponentProps<typeof Textarea>)}
            onChange={(e) => change(e.target.value)}
          />
        ) : (
          <Input {...common} onChange={(e) => change(e.target.value)} />
        )}
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={t('translit.suggestions')}
            data-testid="translit-options"
            className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-border bg-bg shadow-md"
          >
            {options.map((o, i) => (
              <li
                key={o}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                data-testid="translit-option"
                lang={script ? languageOfScript(script) : undefined}
                className={cn(
                  'cursor-pointer px-2 py-1 text-sm',
                  i === active ? 'bg-accent text-accent-fg' : 'hover:bg-surface-2',
                )}
                // mouse down, so the field does not lose focus (and take the first one) before the click lands
                onMouseDown={(e) => {
                  e.preventDefault();
                  take(i);
                }}
              >
                {o}
              </li>
            ))}
            <li
              role="option"
              aria-selected={false}
              data-testid="translit-keep"
              className="cursor-pointer border-t border-border px-2 py-1 text-xs text-fg-muted hover:bg-surface-2"
              onMouseDown={(e) => {
                e.preventDefault();
                setDismissed(word);
              }}
            >
              {t('translit.keepRoman', { text: word })}
            </li>
          </ul>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            aria-label={t('translit.toggle')}
            aria-pressed={script !== null}
            title={script ? t('translit.on', { script: SCRIPT_NAMES[script] }) : t('translit.off')}
            data-testid="translit-toggle"
            className="min-w-(--control-h) shrink-0 px-2"
          >
            <Languages size={16} aria-hidden />
            <span className="text-xs">{script ? SCRIPT_NAMES[script] : 'A'}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-testid="translit-off"
            onSelect={() => {
              setScript(null);
              remember(OFF);
            }}
          >
            {t('translit.off')}
          </DropdownMenuItem>
          {SCRIPTS.map((s) => (
            <DropdownMenuItem
              key={s}
              data-testid={`translit-${s}`}
              lang={languageOfScript(s)}
              onSelect={() => {
                setScript(s);
                remember(s);
              }}
            >
              {SCRIPT_NAMES[s]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
