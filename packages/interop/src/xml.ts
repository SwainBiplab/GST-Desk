/**
 * A small XML writer and a streaming reader. Tally exports are large, sometimes UTF-16, and contain
 * character references XML does not allow (`&#4;`), so a general parser would be the wrong tool.
 *
 * The reader (`XmlStream`) is fed text in pieces. It builds a tree only for the elements asked for
 * (a voucher, a ledger) and hands each to a callback the moment it closes, then forgets it, so memory
 * stays flat however long the file is.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const validXmlChar = (c: number): boolean =>
  c === 0x9 ||
  c === 0xa ||
  c === 0xd ||
  (c >= 0x20 && c <= 0xd7ff) ||
  (c >= 0xe000 && c <= 0xfffd) ||
  (c >= 0x10000 && c <= 0x10ffff);

/** Decode the five named entities and numeric references, dropping characters XML cannot carry. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && validXmlChar(code) ? String.fromCodePoint(code) : '';
    }
    return NAMED[body] ?? m;
  });
}

/** Escape text for an element or attribute value, dropping characters XML 1.0 cannot carry. */
export function escapeXml(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (!validXmlChar(c)) continue;
    out +=
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch;
  }
  return out;
}

export type XmlChild = string | null | undefined | false;

/** `<name attr="v">children</name>`; an element with no children and no text is written empty. */
export function el(
  name: string,
  attrs: Record<string, string | undefined> | null,
  ...children: XmlChild[]
): string {
  const a = attrs
    ? Object.entries(attrs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ` ${k}="${escapeXml(v!)}"`)
        .join('')
    : '';
  const inner = children.filter((c): c is string => typeof c === 'string').join('');
  return inner === '' ? `<${name}${a}/>` : `<${name}${a}>${inner}</${name}>`;
}

/** An element holding text. */
export const txt = (name: string, text: string | number | bigint): string =>
  `<${name}>${escapeXml(String(text))}</${name}>`;

export class XmlStream {
  private buf = '';
  private readonly open: string[] = [];
  private readonly capture: XmlNode[] = [];

  constructor(
    private readonly wanted: ReadonlySet<string>,
    private readonly onElement: (node: XmlNode) => void,
  ) {}

  /** Feed the next piece of text. A tag or entity split across pieces is held until the rest arrives. */
  write(chunk: string): void {
    this.buf += chunk;
    this.drain(false);
  }

  /** No more text is coming. */
  end(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    const b = this.buf;
    let i = 0;
    while (i < b.length) {
      const lt = b.indexOf('<', i);
      if (lt === -1) {
        if (final) {
          this.text(b.slice(i));
          i = b.length;
        }
        break;
      }
      if (lt > i) {
        this.text(b.slice(i, lt));
        i = lt;
      }
      let j: number;
      if (b.startsWith('<!--', lt)) {
        j = b.indexOf('-->', lt + 4);
        if (j === -1) break;
        i = j + 3;
      } else if (b.startsWith('<![CDATA[', lt)) {
        j = b.indexOf(']]>', lt + 9);
        if (j === -1) break;
        this.text(b.slice(lt + 9, j), true);
        i = j + 3;
      } else if (b.startsWith('<?', lt)) {
        j = b.indexOf('?>', lt + 2);
        if (j === -1) break;
        i = j + 2;
      } else if (b.startsWith('<!', lt)) {
        j = b.indexOf('>', lt + 2);
        if (j === -1) break;
        i = j + 1;
      } else {
        j = tagEnd(b, lt);
        if (j === -1) break;
        this.tag(b.slice(lt + 1, j));
        i = j + 1;
      }
    }
    this.buf = b.slice(i);
  }

  private text(s: string, raw = false): void {
    if (this.capture.length === 0 || s === '') return;
    const top = this.capture[this.capture.length - 1]!;
    top.text += raw ? s : decodeEntities(s);
  }

  private tag(inner: string): void {
    if (inner.startsWith('/')) {
      this.close();
      return;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) return;
    const name = m[1]!;
    const attrs: Record<string, string> = {};
    const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = re.exec(body.slice(name.length))))
      attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '');
    this.open.push(name);
    if (this.capture.length > 0 || this.wanted.has(name)) {
      const node: XmlNode = { name, attrs, children: [], text: '' };
      if (this.capture.length > 0) this.capture[this.capture.length - 1]!.children.push(node);
      this.capture.push(node);
    }
    if (selfClosing) this.close();
  }

  private close(): void {
    this.open.pop();
    if (this.capture.length === 0) return;
    const node = this.capture.pop()!;
    node.text = node.text.trim();
    if (this.capture.length === 0) this.onElement(node);
  }
}

/** The `>` that ends the tag starting at `from`, skipping any inside quotes; -1 when it has not arrived. */
function tagEnd(b: string, from: number): number {
  let quote = '';
  for (let k = from + 1; k < b.length; k++) {
    const c = b[k]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return k;
  }
  return -1;
}

/** Read a whole string, handing back each wanted element as it closes. */
export function readXml(
  source: string,
  wanted: ReadonlySet<string>,
  onElement: (n: XmlNode) => void,
): void {
  const s = new XmlStream(wanted, onElement);
  s.write(source);
  s.end();
}

/** Read text that arrives in pieces (a file stream), without holding it all. */
export async function readXmlAsync(
  source: AsyncIterable<string>,
  wanted: ReadonlySet<string>,
  onElement: (n: XmlNode) => void,
): Promise<void> {
  const s = new XmlStream(wanted, onElement);
  for await (const chunk of source) s.write(chunk);
  s.end();
}

/** Turn the bytes of an XML file into text, honouring a UTF-16 byte order mark (Tally writes those). */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The encoding a file starts in, from its first bytes: for `TextDecoderStream`. */
export function sniffXmlEncoding(head: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

/** The first child of a node with a name, or undefined. */
export const child = (n: XmlNode, name: string): XmlNode | undefined =>
  n.children.find((c) => c.name === name);

/** Every child with a name. */
export const kids = (n: XmlNode, name: string): XmlNode[] =>
  n.children.filter((c) => c.name === name);

/** The text of the first child with a name, or an empty string. */
export const textOf = (n: XmlNode, name: string): string => child(n, name)?.text ?? '';
