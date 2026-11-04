/** JSON <-> bigint helpers shared by the vector scripts and the vector test. bigint is written as "123n". */

export function dump(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2) + '\n';
}

export function load<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as T;
}

export interface VectorLine {
  qtyMicros: bigint;
  ratePaise: bigint;
  discount:
    | { mode: 'none' }
    | { mode: 'percent'; bp: number }
    | { mode: 'per_unit'; perUnitPaise: bigint }
    | { mode: 'price_includes_tax' };
  pricing?: 'exclusive' | 'inclusive';
  gstRateBp: number;
  cessBp?: number;
  cessPerUnitPaise?: bigint;
  taxability?: 'taxable' | 'exempt' | 'nil_rated' | 'non_gst';
}

export interface Vector {
  name: string;
  category: string;
  /** Statutory rule the case exercises. */
  rule: string;
  input: {
    lines: VectorLine[];
    options: Record<string, unknown>;
  };
  expect: {
    /** Subset of DocumentTotals; only listed keys are compared. */
    totals: Record<string, bigint>;
    /** Optional per-line subsets of LineResult. */
    lines?: Record<string, unknown>[];
  };
}
