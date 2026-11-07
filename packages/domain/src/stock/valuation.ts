/**
 * Stock valuation (prompt 51, FR-112). Pure arithmetic over one item's movements in date order: FIFO
 * keeps cost layers and consumes the oldest first; weighted average keeps one pool and takes every unit
 * out at the pool's average. Either way the engine says what each movement cost, what is left and what it
 * is worth. Quantities are integers in millionths of a unit; money is paise as BigInt.
 *
 * The repository stores the movements and runs this over them; the ledger's cost of goods sold is what
 * the engine said at the time the sale was issued (`ValuationRepo`), and the audit compares the two.
 */
import { divRound } from '../money';

export const VALUATION_METHODS = ['fifo', 'wavg'] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];
export const isValuationMethod = (v: unknown): v is ValuationMethod => v === 'fifo' || v === 'wavg';

const MICRO = 1_000_000n;

/** One movement as the engine sees it. */
export interface StockEvent {
  id: string;
  /** ISO date; events are processed in this order (ties keep the given order). */
  date: string;
  /** Signed: positive brings stock in. Zero with a cost is a revaluation. */
  qtyMicros: number;
  /**
   * The total cost of the movement when it is known: a purchase at its taxable value, an opening at its
   * stated value, an adjustment at a given rate, a reversal at what the reversed movement cost. `null`
   * leaves it to the engine: an out is costed by the method, an in (a sales return) at the current unit
   * cost. For a revaluation (zero quantity) it is the signed change in value.
   */
  costPaise: bigint | null;
}

/** A cost layer: what came in on a date, what is left of it and what that remainder cost. */
export interface CostLayer {
  date: string;
  qtyMicros: number;
  costPaise: bigint;
}

export interface ValuationResult {
  /** The cost the engine assigned to each event (total, never negative for ins and outs). */
  costs: Map<string, bigint>;
  qtyMicros: number;
  valuePaise: bigint;
  /** Paise per unit of what is on hand, zero when nothing is. */
  unitCostPaise: bigint;
  /** The physical layers still on hand, oldest first (both methods keep them, for ageing). */
  layers: CostLayer[];
}

const unitCost = (valuePaise: bigint, qtyMicros: number): bigint =>
  qtyMicros > 0 ? divRound(valuePaise * MICRO, BigInt(qtyMicros)) : 0n;

/** The cost of `take` units out of a layer, in proportion; the whole layer when all of it goes. */
const slice = (layer: CostLayer, take: number): bigint =>
  take >= layer.qtyMicros
    ? layer.costPaise
    : divRound(layer.costPaise * BigInt(take), BigInt(layer.qtyMicros));

/**
 * Run the method over the events, in date order. The result carries the cost of every event and the
 * closing position. Negative stock is allowed: the units that were not there are costed at the last
 * known unit cost (or `fallbackUnitCostPaise`, the item's purchase price, when nothing is known), the
 * value carries what they were charged, and the next in fills the hole before it forms a layer. While
 * anything is on hand the layers add up to the value.
 */
export function runValuation(
  method: ValuationMethod,
  events: readonly StockEvent[],
  fallbackUnitCostPaise = 0n,
): ValuationResult {
  const ordered = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i));
  const costs = new Map<string, bigint>();
  let qty = 0;
  let value = 0n;
  let lastUnit = fallbackUnitCostPaise;
  let layers: CostLayer[] = [];

  /** Take `take` units off the oldest layers; returns their layer cost and how many could not be found. */
  const consume = (take: number): { costPaise: bigint; missing: number } => {
    let left = take;
    let cost = 0n;
    while (left > 0 && layers.length > 0) {
      const top = layers[0]!;
      const part = Math.min(left, top.qtyMicros);
      const c = slice(top, part);
      cost += c;
      left -= part;
      if (part >= top.qtyMicros) layers.shift();
      else {
        top.qtyMicros -= part;
        top.costPaise -= c;
      }
    }
    return { costPaise: cost, missing: left };
  };

  for (const { e } of ordered) {
    if (e.qtyMicros > 0) {
      const q = e.qtyMicros;
      const current = qty > 0 ? unitCost(value, qty) : lastUnit;
      const cost = e.costPaise ?? divRound(current * BigInt(q), MICRO);
      costs.set(e.id, cost);
      if (qty <= 0) {
        // nothing (or less than nothing) is on hand: the in fills the hole first, and the one layer it
        // forms carries what the missing units were charged, so the layers again add up to the value
        const layerQty = q - Math.min(-qty, q);
        layers = [];
        if (layerQty > 0)
          layers.push({ date: e.date, qtyMicros: layerQty, costPaise: value + cost });
      } else {
        layers.push({ date: e.date, qtyMicros: q, costPaise: cost });
      }
      qty += q;
      value += cost;
      lastUnit = unitCost(cost, q);
    } else if (e.qtyMicros < 0) {
      const q = -e.qtyMicros;
      let cost: bigint;
      if (e.costPaise !== null) {
        // a reversal or a stated cost: the layers lose the units, the value loses exactly this
        const taken = consume(q);
        cost = e.costPaise;
        const diff = taken.costPaise - cost;
        if (diff !== 0n && layers.length > 0) layers[layers.length - 1]!.costPaise += diff;
      } else if (method === 'fifo') {
        const taken = consume(q);
        cost = taken.costPaise;
        if (taken.missing > 0) {
          const unit = qty - (q - taken.missing) > 0 ? unitCost(value, qty) : lastUnit;
          cost += divRound(unit * BigInt(taken.missing), MICRO);
        }
      } else {
        // weighted average: every unit out at the pool's average; all of it when all goes
        const within = Math.min(q, Math.max(qty, 0));
        cost =
          within >= qty && qty > 0
            ? value
            : qty > 0
              ? divRound(value * BigInt(within), BigInt(qty))
              : 0n;
        const missing = q - within;
        if (missing > 0) {
          const unit = qty > 0 ? unitCost(value, qty) : lastUnit;
          cost += divRound(unit * BigInt(missing), MICRO);
        }
        const taken = consume(q);
        const diff = taken.costPaise - cost;
        if (diff !== 0n && layers.length > 0) layers[layers.length - 1]!.costPaise += diff;
      }
      if (qty > 0) lastUnit = unitCost(value, qty);
      costs.set(e.id, cost);
      qty -= q;
      value -= cost;
      if (qty <= 0) layers = [];
    } else if (e.costPaise !== null && e.costPaise !== 0n) {
      // revaluation: the value moves, the units do not; spread over the layers in proportion
      costs.set(e.id, e.costPaise);
      value += e.costPaise;
      const total = layers.reduce((s, l) => s + BigInt(l.qtyMicros), 0n);
      if (total > 0n) {
        let spread = 0n;
        layers.forEach((l, i) => {
          const part =
            i === layers.length - 1
              ? e.costPaise! - spread
              : divRound(e.costPaise! * BigInt(l.qtyMicros), total);
          l.costPaise += part;
          spread += part;
        });
      }
      if (qty > 0) lastUnit = unitCost(value, qty);
    } else {
      costs.set(e.id, 0n);
    }
  }
  return { costs, qtyMicros: qty, valuePaise: value, unitCostPaise: unitCost(value, qty), layers };
}

/** Days from `from` to `to` (ISO dates), whole days; negative when `to` is earlier. */
export const daysUntil = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const AGE_BUCKETS = [30, 60, 90, 180] as const;

/** How much of what is on hand came in within each age bucket: 0–30, 31–60, 61–90, 91–180 and older. */
export function ageStock(
  layers: readonly CostLayer[],
  asOf: string,
  bounds: readonly number[] = AGE_BUCKETS,
): { qtyMicros: number[]; valuePaise: bigint[] } {
  const qtyMicros = Array.from({ length: bounds.length + 1 }, () => 0);
  const valuePaise = Array.from({ length: bounds.length + 1 }, () => 0n);
  for (const l of layers) {
    const age = daysUntil(l.date, asOf);
    let b = bounds.findIndex((limit) => age <= limit);
    if (b < 0) b = bounds.length;
    qtyMicros[b]! += l.qtyMicros;
    valuePaise[b]! += l.costPaise;
  }
  return { qtyMicros, valuePaise };
}

/** Quantity times a unit cost, in whole paise. */
export const valueAt = (qtyMicros: number, unitCostPaise: bigint): bigint =>
  divRound(BigInt(qtyMicros) * unitCostPaise, MICRO);
