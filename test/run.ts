// Run: bun test/run.ts   (or: npm test)
import { computeMargin, splitNetProfit } from "../src/finance.js";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "  ✓" : "  ✗ FAIL:"} ${m}`); if (!c) fails++; };

console.log("Finley — margin");
const m = computeMargin({
  lines: [{ retailCents: 4000, cogsCents: 1800, quantity: 2 }], // retail 8000, cogs 3600
  shippingChargedCents: 500,
  shippingCostCents: 450,
  taxCollectedCents: 700, // pass-through
});
// gross = 8500; processor = round(9200*0.029+30)=round(296.8)=297
ok(m.grossRevenueCents === 8500, "gross revenue = retail + shipping charged");
ok(m.processorFeeCents === 297, `processor fee estimated on gross+tax (got ${m.processorFeeCents})`);
ok(m.netProfitCents === 8500 - 3600 - 450 - 297, "net = gross - cogs - shipcost - fee");
ok(m.taxCollectedCents === 700, "tax tracked as pass-through, not profit");
ok(Math.abs(m.marginPct - m.netProfitCents / 8500) < 1e-9, "marginPct consistent");

console.log("Finley — profit split (exact cents)");
const env = [
  { name: "cogs", allocation: 0 },
  { name: "operating", allocation: 0.4 },
  { name: "savings", allocation: 0.3 },
  { name: "profit", allocation: 0.3 },
];
const split = splitNetProfit(1000, env);
ok(Object.values(split).reduce((s, n) => s + n, 0) === 1000, "splits sum EXACTLY to net profit");
ok(split.cogs === 0, "zero-allocation envelope gets nothing");
// 1 cent that can't divide evenly still conserved
const odd = splitNetProfit(101, env);
ok(Object.values(odd).reduce((s, n) => s + n, 0) === 101, "odd amount conserved to the cent");
// loss case
const loss = splitNetProfit(-50, env);
ok(Object.values(loss).reduce((s, n) => s + n, 0) === -50, "loss distributed (sums to -50)");
ok(splitNetProfit(0, env).profit === 0, "zero profit → zero everywhere");

console.log("");
if (fails === 0) console.log("ALL PASSED ✅"); else { console.error(`${fails} FAILED ❌`); process.exit(1); }
