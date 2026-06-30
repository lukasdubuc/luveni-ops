// ─────────────────────────────────────────────────────────────
//  Luveni Ops — Finley's finance core (pure, unit-tested)
//  Exact base-margin maths, tax handling, and net-profit splitting into
//  budgeting envelopes. Kept pure so it's deterministic and testable;
//  the Finley agent wraps it with DB reads/writes.
// ─────────────────────────────────────────────────────────────

export interface OrderLine {
  /** Retail charged to the customer (cents, pre-tax). */
  retailCents: number;
  /** Manufacturer cost of goods (cents). */
  cogsCents: number;
  quantity: number;
}

export interface TransactionInput {
  lines: OrderLine[];
  /** Shipping charged to the customer (cents). */
  shippingChargedCents?: number;
  /** Shipping we actually paid the supplier (cents). */
  shippingCostCents?: number;
  /** Sales tax collected (cents) — pass-through, never profit. */
  taxCollectedCents?: number;
  /** Payment processor fee (cents). If omitted, estimated from rate. */
  processorFeeCents?: number;
  /** Processor rate + fixed (Stripe default 2.9% + 30¢) used when fee omitted. */
  processorRate?: number;
  processorFixedCents?: number;
}

export interface MarginBreakdown {
  grossRevenueCents: number;   // retail + shipping charged (ex-tax)
  cogsCents: number;
  shippingCostCents: number;
  processorFeeCents: number;
  netProfitCents: number;      // what actually splits into envelopes
  marginPct: number;           // netProfit / grossRevenue (0..1)
  taxCollectedCents: number;   // pass-through, set aside separately
}

const round = (n: number) => Math.round(n);

/** Compute the exact margin breakdown for one transaction. */
export function computeMargin(tx: TransactionInput): MarginBreakdown {
  const retail = tx.lines.reduce((s, l) => s + l.retailCents * l.quantity, 0);
  const cogs = tx.lines.reduce((s, l) => s + l.cogsCents * l.quantity, 0);
  const shipCharged = tx.shippingChargedCents ?? 0;
  const shipCost = tx.shippingCostCents ?? 0;
  const tax = tx.taxCollectedCents ?? 0;

  const grossRevenue = retail + shipCharged;
  const processorFee = tx.processorFeeCents ?? round(
    (grossRevenue + tax) * (tx.processorRate ?? 0.029) + (tx.processorFixedCents ?? 30),
  );

  const netProfit = grossRevenue - cogs - shipCost - processorFee;
  return {
    grossRevenueCents: grossRevenue,
    cogsCents: cogs,
    shippingCostCents: shipCost,
    processorFeeCents: processorFee,
    netProfitCents: netProfit,
    marginPct: grossRevenue > 0 ? netProfit / grossRevenue : 0,
    taxCollectedCents: tax,
  };
}

export interface EnvelopeAllocation { name: string; allocation: number }

/**
 * Split net profit across budgeting envelopes by their allocation shares.
 * Uses largest-remainder rounding so the parts always sum EXACTLY to the
 * net profit (no lost/created cents). Negative profit (a loss) is drawn
 * proportionally from the same envelopes.
 */
export function splitNetProfit(
  netProfitCents: number,
  envelopes: EnvelopeAllocation[],
): Record<string, number> {
  const valid = envelopes.filter((e) => e.allocation > 0);
  const totalShare = valid.reduce((s, e) => s + e.allocation, 0);
  if (totalShare <= 0 || netProfitCents === 0) {
    return Object.fromEntries(envelopes.map((e) => [e.name, 0]));
  }

  const exact = valid.map((e) => ({
    name: e.name,
    raw: (netProfitCents * e.allocation) / totalShare,
  }));
  const floored = exact.map((e) => ({ name: e.name, cents: Math.trunc(e.raw), frac: e.raw - Math.trunc(e.raw) }));
  let remainder = netProfitCents - floored.reduce((s, e) => s + e.cents, 0);

  // Distribute the leftover cents to the largest fractional parts.
  const order = [...floored].sort((a, b) => Math.abs(b.frac) - Math.abs(a.frac));
  const step = remainder >= 0 ? 1 : -1;
  for (let i = 0; remainder !== 0; i = (i + 1) % order.length) {
    order[i].cents += step;
    remainder -= step;
  }

  const out: Record<string, number> = Object.fromEntries(envelopes.map((e) => [e.name, 0]));
  for (const e of floored) out[e.name] = e.cents;
  return out;
}
