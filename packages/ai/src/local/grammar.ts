/**
 * A llama.cpp grammar (GBNF) from a Zod schema, so a small model can only answer in the shape the
 * caller asked for. The schema is still checked afterwards (`validated`): the grammar makes a good answer
 * likely, the check makes a bad one impossible.
 *
 * Covered: objects, strings, numbers (integers when the schema says so), booleans, arrays, enums,
 * literals, nullable, optional (emitted as nullable: the key is always present), unions and records.
 * A string regex is not turned into a grammar; the check after generation enforces it.
 */
import type { z } from 'zod';

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  entries?: Record<string, string | number>;
  values?: (string | number | boolean)[];
  valueType?: z.ZodType;
  checks?: { _zod: { def: { check: string; format?: string } } }[];
}

const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

const PRELUDE = [
  'ws ::= [ \\t\\n]*',
  'string ::= "\\"" ( [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]) )* "\\""',
  'integer ::= "-"? ("0" | [1-9] [0-9]*)',
  'number ::= integer ("." [0-9]+)? ([eE] [-+]? [0-9]+)?',
  'boolean ::= "true" | "false"',
  'null ::= "null"',
  'value ::= object | array | string | number | boolean | null',
  'object ::= "{" ws ( string ws ":" ws value ( ws "," ws string ws ":" ws value )* )? ws "}"',
  'array ::= "[" ws ( value ( ws "," ws value )* )? ws "]"',
];

const lit = (s: string): string => JSON.stringify(JSON.stringify(s));

export class GrammarBuilder {
  private readonly rules = new Map<string, string>();
  private n = 0;

  private add(body: string, hint: string): string {
    const name = `${hint}${this.n++}`;
    this.rules.set(name, body);
    return name;
  }

  rule(schema: z.ZodType): string {
    const d = defOf(schema);
    switch (d.type) {
      case 'string':
        return 'string';
      case 'number': {
        const int = d.checks?.some((c) => c._zod.def.check === 'number_format');
        return int ? 'integer' : 'number';
      }
      case 'int':
        return 'integer';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'literal':
        return this.add(
          (d.values ?? [])
            .map((v) => (typeof v === 'string' ? lit(v) : `"${String(v)}"`))
            .join(' | '),
          'lit',
        );
      case 'enum':
        return this.add(
          Object.values(d.entries ?? {})
            .map((v) => (typeof v === 'string' ? lit(v) : `"${String(v)}"`))
            .join(' | '),
          'enum',
        );
      case 'nullable':
      case 'optional':
      case 'default': {
        const inner = this.rule(d.innerType!);
        return this.add(`${inner} | null`, 'opt');
      }
      case 'array': {
        const el = this.rule(d.element!);
        return this.add(`"[" ws ( ${el} ( ws "," ws ${el} )* )? ws "]"`, 'arr');
      }
      case 'union':
        return this.add((d.options ?? []).map((o) => this.rule(o)).join(' | '), 'union');
      case 'record':
        return 'object';
      case 'object': {
        const keys = Object.entries(d.shape ?? {});
        if (keys.length === 0) return this.add('"{" ws "}"', 'obj');
        const parts = keys.map(
          ([k, v], i) => `${i ? 'ws "," ws ' : ''}${lit(k)} ws ":" ws ${this.rule(v)}`,
        );
        return this.add(`"{" ws ${parts.join(' ')} ws "}"`, 'obj');
      }
      case 'pipe':
      case 'readonly':
      case 'catch':
      case 'lazy':
        return d.innerType ? this.rule(d.innerType) : 'value';
      default:
        return 'value';
    }
  }

  build(root: z.ZodType): string {
    const r = this.rule(root);
    const out = [`root ::= ws ${r} ws`, ...PRELUDE];
    for (const [name, body] of this.rules) out.push(`${name} ::= ${body}`);
    return out.join('\n');
  }
}

/** The grammar for one schema. Deterministic: the same schema gives the same text. */
export const gbnf = (schema: z.ZodType): string => new GrammarBuilder().build(schema);

/**
 * Pull the first JSON object or array out of model text: a model with no grammar sometimes wraps the
 * answer in prose or a code fence.
 */
export function extractJson(text: string): unknown | undefined {
  const s = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const start = Math.min(...['{', '['].map((c) => s.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) return undefined;
  // walk to the matching close, respecting strings
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
