import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemo,
  canonicalJson,
  dayKey,
  evaluate,
  FileLedger,
  GateError,
  hash8,
  loadPolicy,
  MemoryLedger,
  parseMemo,
  PolicyGate,
  policyHash,
  spentToday,
  type LedgerEntry,
  type Policy,
} from "./index";

const policy: Policy = {
  version: 1,
  timezone: "Asia/Kolkata",
  dailyBudgetInr: 1000,
  perTxMaxInr: 1000,
  confirmAboveInr: 500,
  merchantAllowList: ["bitrefill"],
  categoryCapsInr: { mobile_topup: 600, gift_card: 1000 },
};

// 2026-11-04 14:00 IST
const NOW = new Date("2026-11-04T08:30:00Z");
const req = (amountInr: number, category = "mobile_topup", merchant = "bitrefill") => ({
  merchant,
  category,
  amountInr,
  productId: "jio-india",
});
const spend = (amountInr: number, ts: string, category = "mobile_topup"): LedgerEntry => ({
  ts,
  kind: "spend",
  runId: "r0",
  merchant: "bitrefill",
  category,
  amountInr,
  productId: "x",
  policyHash: "h",
});

describe("evaluate()", () => {
  test("small Jio recharge is auto-approved", () => {
    const d = evaluate(policy, req(239), [], NOW);
    expect(d.allowed).toBe(true);
    expect(d.needsHuman).toBe(false);
    expect(d.spentTodayInr).toBe(0);
    expect(d.remainingInr).toBe(1000);
  });

  test("exactly at the confirm limit does not need a human; one rupee more does", () => {
    expect(evaluate(policy, req(500, "gift_card"), [], NOW).needsHuman).toBe(false);
    const d = evaluate(policy, req(501, "gift_card"), [], NOW);
    expect(d.allowed).toBe(true);
    expect(d.needsHuman).toBe(true);
    expect(d.reasons.join(" ")).toContain("human");
  });

  test("merchant not on allow-list is denied (case-insensitive match for allowed one)", () => {
    expect(evaluate(policy, req(100, "mobile_topup", "amazon.in"), [], NOW).allowed).toBe(false);
    expect(evaluate(policy, req(100, "mobile_topup", "  BitRefill "), [], NOW).allowed).toBe(true);
  });

  test("unknown category is denied", () => {
    const d = evaluate(policy, req(100, "crypto_atm"), [], NOW);
    expect(d.allowed).toBe(false);
    expect(d.needsHuman).toBe(false);
  });

  test("prototype keys are not categories", () => {
    expect(evaluate(policy, req(1, "toString"), [], NOW).allowed).toBe(false);
    expect(evaluate(policy, req(1, "__proto__"), [], NOW).allowed).toBe(false);
  });

  test("invalid amounts are denied", () => {
    for (const a of [0, -5, NaN, Infinity]) {
      expect(evaluate(policy, req(a), [], NOW).allowed).toBe(false);
    }
    expect(evaluate(policy, { ...req(1), amountInr: "239" as unknown as number }, [], NOW).allowed).toBe(false);
  });

  test("per-purchase cap", () => {
    const p = { ...policy, perTxMaxInr: 300 };
    expect(evaluate(p, req(301, "gift_card"), [], NOW).allowed).toBe(false);
    expect(evaluate(p, req(300, "gift_card"), [], NOW).allowed).toBe(true);
  });

  test("daily budget counts today's spends only (IST day boundary)", () => {
    const ledger = [
      spend(700, "2026-11-04T01:00:00Z", "gift_card"), // 06:30 IST today
      spend(900, "2026-11-03T18:00:00Z", "gift_card"), // 23:30 IST yesterday
    ];
    expect(spentToday(policy, ledger, NOW)).toBe(700);
    const ok = evaluate(policy, req(300, "gift_card"), ledger, NOW);
    expect(ok.allowed).toBe(true);
    expect(ok.remainingInr).toBe(300);
    const over = evaluate(policy, req(301, "gift_card"), ledger, NOW);
    expect(over.allowed).toBe(false);
    expect(over.needsHuman).toBe(false);
    expect(over.reasons.join(" ")).toContain("daily budget");
  });

  test("18:45 UTC is already tomorrow in IST", () => {
    expect(dayKey(new Date("2026-11-03T18:45:00Z"), "Asia/Kolkata")).toBe("2026-11-04");
  });

  test("decision and human entries do not count as spend", () => {
    const ledger: LedgerEntry[] = [
      { ...spend(900, NOW.toISOString()), kind: "decision" },
      { ...spend(900, NOW.toISOString()), kind: "human", approved: true },
    ];
    expect(evaluate(policy, req(239), ledger, NOW).spentTodayInr).toBe(0);
  });

  test("category cap is enforced separately from the daily budget", () => {
    const ledger = [spend(400, NOW.toISOString(), "mobile_topup")];
    expect(evaluate(policy, req(200), ledger, NOW).allowed).toBe(true);
    const d = evaluate(policy, req(201), ledger, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toContain("mobile_topup cap");
    // the same amount as a gift card is fine
    expect(evaluate(policy, req(201, "gift_card"), ledger, NOW).allowed).toBe(true);
  });

  test("denied requests never ask a human", () => {
    const d = evaluate(policy, req(1500, "gift_card"), [], NOW);
    expect(d.allowed).toBe(false);
    expect(d.needsHuman).toBe(false);
  });

  test("is pure: does not mutate inputs", () => {
    const ledger = [spend(100, NOW.toISOString())];
    const snapP = JSON.stringify(policy);
    const snapL = JSON.stringify(ledger);
    evaluate(policy, req(239), ledger, NOW);
    expect(JSON.stringify(policy)).toBe(snapP);
    expect(JSON.stringify(ledger)).toBe(snapL);
    expect(evaluate(policy, req(239), ledger, NOW)).toEqual(evaluate(policy, req(239), ledger, NOW));
  });
});

describe("policy hash + memo", () => {
  test("hash is key-order independent and changes with content", () => {
    const shuffled = JSON.parse(JSON.stringify({ categoryCapsInr: policy.categoryCapsInr, ...policy }));
    expect(policyHash(shuffled)).toBe(policyHash(policy));
    expect(policyHash({ ...policy, dailyBudgetInr: 1001 })).not.toBe(policyHash(policy));
    expect(policyHash(policy)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  test("memo format ZR1|<invoice>|<hash8> round-trips", () => {
    const memo = buildMemo("inv_123", policy);
    expect(memo).toBe(`ZR1|inv_123|${hash8(policy)}`);
    expect(parseMemo(memo)).toEqual({ invoiceId: "inv_123", hash8: hash8(policy) });
    expect(new TextEncoder().encode(memo).length).toBeLessThan(512);
    expect(() => buildMemo("a|b", policy)).toThrow();
    expect(parseMemo("hello")).toBeNull();
  });

  test("shipped data/policy.json loads and has the demo limits", () => {
    const p = loadPolicy();
    expect(p.dailyBudgetInr).toBe(1000);
    expect(p.confirmAboveInr).toBe(500);
    expect(p.merchantAllowList).toEqual(["bitrefill"]);
  });

  test("loadPolicy rejects malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "zr-"));
    const f = join(dir, "p.json");
    writeFileSync(f, JSON.stringify({ ...policy, dailyBudgetInr: "lots" }));
    expect(() => loadPolicy(f)).toThrow();
  });
});

describe("ledger", () => {
  test("FileLedger appends JSONL and skips corrupt lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "zr-"));
    const l = new FileLedger(join(dir, "sub", "ledger.jsonl"));
    expect(l.entries()).toEqual([]);
    l.append(spend(10, NOW.toISOString()));
    l.append(spend(20, NOW.toISOString()));
    writeFileSync(l.path, readFileSync(l.path, "utf8") + "{not json\n");
    l.append(spend(30, NOW.toISOString()));
    expect(l.entries().map((e) => e.amountInr)).toEqual([10, 20, 30]);
    expect(readFileSync(l.path, "utf8").trim().split("\n").length).toBe(4);
  });
});

describe("PolicyGate (the code path the LLM cannot skip)", () => {
  const mk = () => new PolicyGate(policy, new MemoryLedger(), () => NOW);

  test("nothing is authorized before request_approval", () => {
    const g = mk();
    expect(() => g.authorize("run1", "pay_shielded")).toThrow(GateError);
    expect(() => g.authorize("run1", "create_invoice")).toThrow(/never called/);
  });

  test("auto-approved run is authorized, logged, and spend counts toward the budget", () => {
    const g = mk();
    const d = g.request("run1", req(239));
    expect(d.allowed && !d.needsHuman).toBe(true);
    expect(() => g.authorize("run1", "pay_shielded", { productId: "jio-india", amountInr: 239 })).not.toThrow();
    g.recordSpend("run1", { invoiceId: "inv1", txid: "tx1", mode: "mock" });
    g.recordSpend("run1", { invoiceId: "inv1", txid: "tx1", mode: "mock" }); // idempotent
    expect(g.status().spentTodayInr).toBe(239);
    expect(g.status().byCategory.mobile_topup!.spentInr).toBe(239);
    expect(g.ledger.entries().map((e) => e.kind)).toEqual(["decision", "spend"]);
    expect(() => g.authorize("run1", "confirm_order")).not.toThrow();
  });

  test("over-limit run waits for a human, and a rejection blocks it", () => {
    const g = mk();
    expect(g.request("big", req(700, "gift_card")).needsHuman).toBe(true);
    expect(() => g.authorize("big", "pay_shielded")).toThrow(/waiting for human/);
    g.recordHuman("big", false);
    expect(() => g.authorize("big", "pay_shielded")).toThrow(/rejected/);
    g.recordHuman("big", true);
    expect(() => g.authorize("big", "pay_shielded")).not.toThrow();
  });

  test("a denied run cannot be overridden by a human", () => {
    const g = mk();
    expect(g.request("deny", req(5000, "gift_card")).allowed).toBe(false);
    expect(() => g.recordHuman("deny", true)).toThrow(/cannot override/);
    expect(() => g.authorize("deny", "pay_shielded")).toThrow(/denied/);
  });

  test("the paid product and amount must match what was approved", () => {
    const g = mk();
    g.request("r", req(239));
    expect(() => g.authorize("r", "pay_shielded", { amountInr: 999 })).toThrow(/differs/);
    expect(() => g.authorize("r", "create_invoice", { productId: "amazon" })).toThrow(/differs/);
  });

  test("budget is re-checked at pay time (two approved runs cannot both overspend)", () => {
    const g = mk();
    g.request("a", req(450, "gift_card"));
    g.request("b", req(450, "gift_card"));
    g.request("c", req(200, "gift_card"));
    g.authorize("a", "pay_shielded");
    g.recordSpend("a", {});
    g.authorize("b", "pay_shielded");
    g.recordSpend("b", {});
    expect(() => g.authorize("c", "pay_shielded")).toThrow(/re-check/);
  });

  test("memo carries the policy hash", () => {
    const g = mk();
    expect(g.memo("inv9")).toBe(`ZR1|inv9|${policyHash(policy).slice(0, 8)}`);
  });
});
