/**
 * Rich text for notes and terms, limited to a safe subset. Anything not on the allowlist is removed:
 * scripts, styles, event handlers, unknown tags and attributes, and links other than http(s) and
 * mailto. Tags are balanced. The output is what is stored and what reaches the PDF.
 */

const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'br', 'p', 'ul', 'ol', 'li', 'a']);
const VOID = new Set(['br']);
/** Content of these is dropped, not just the tags. */
const DROP_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'svg',
  'math',
]);

const ENTITY: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

const escapeText = (s: string) =>
  s
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY[m] ?? m)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

/** A link target that cannot run script. Control characters and whitespace are removed before checking. */
function safeHref(raw: string): string | null {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what hides "java\tscript:"
  const href = raw.replace(/[\u0000- \u007f-\u009f]/g, '');
  return /^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(href) ? href : null;
}

function hrefOf(attrs: string): string | null {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const value = m?.[1] ?? m?.[2] ?? m?.[3];
  if (value === undefined) return null;
  return safeHref(value.replace(/&amp;/g, '&'));
}

export function sanitiseRichText(html: string): string {
  const tokens = html.match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|<|[^<]+/g) ?? [];
  const open: string[] = [];
  let out = '';
  let dropping: string | null = null;

  for (const tok of tokens) {
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>$/.exec(tok);
    if (dropping) {
      if (tag?.[1] === '/' && tag[2]!.toLowerCase() === dropping) dropping = null;
      continue;
    }
    if (tok.startsWith('<!--')) continue;
    if (!tag) {
      out += escapeText(tok);
      continue;
    }
    const closing = tag[1] === '/';
    const name = tag[2]!.toLowerCase();
    if (DROP_CONTENT.has(name)) {
      if (!closing && !/\/\s*$/.test(tag[3]!)) dropping = name;
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    if (VOID.has(name)) {
      if (!closing) out += `<${name}>`;
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at < 0) continue;
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }
    if (name === 'a') {
      const href = hrefOf(tag[3]!);
      if (!href) continue;
      out += `<a href="${escapeAttr(href)}" rel="noopener noreferrer" target="_blank">`;
    } else out += `<${name}>`;
    open.push(name);
  }
  while (open.length > 0) out += `</${open.pop()}>`;
  return out;
}

/** The text a sanitised fragment shows, with line breaks where blocks end. For previews and PDFs without markup. */
export function richTextToPlain(html: string): string {
  return sanitiseRichText(html)
    .replace(/<br>|<\/p>|<\/li>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
