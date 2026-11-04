import type { PolicyDecision } from "../types";
import type { LedgerEntry, Policy, PolicyRequest } from "./types";

/** Calendar day (YYYY-MM-DD) of `d` in the policy's time zone. */
export function dayKey(d: Date, timezone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Sum of today's committed spends (kind === "spend"), optionally for one category. */
export function spentToday(policy: Policy, ledger: LedgerEntry[], now: Date, category?: string): number {
  const today = dayKey(now, policy.timezone);
  let sum = 0;
  for (const e of ledger) {
    if (e.kind !== "spend") continue;
    if (!Number.isFinite(e.amountInr) || e.amountInr <= 0) continue;
    const ts = new Date(e.ts);
    if (Number.isNaN(ts.getTime()) || dayKey(ts, policy.timezone) !== today) continue;
    if (category !== undefined && e.category !== category) continue;
    sum += e.amountInr;
  }
  return round2(sum);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The mandate gate. Pure: same inputs, same output, no I/O.
 * `now` defaults to the current time but tests pass it explicitly.
 *
 * Deny rules (any one denies): bad amount, merchant not allow-listed, unknown category,
 * per-transaction cap, daily budget, category cap. If allowed and the amount is strictly
 * above `confirmAboveInr`, a human must confirm (needsHuman = true).
 */
export function evaluate(policy: Policy, req: PolicyRequest, ledger: LedgerEntry[], now: Date = new Date()): PolicyDecision {
  const reasons: string[] = [];
  const amount = req.amountInr;
  const spent = spentToday(policy, ledger, now);
  const remainingBefore = round2(Math.max(0, policy.dailyBudgetInr - spent));

  let allowed = true;
  const deny = (r: string) => {
    allowed = false;
    reasons.push(r);
  };

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    deny(`invalid amount: ${String(amount)}`);
  }

  const merchant = String(req.merchant ?? "").trim().toLowerCase();
  const allowList = policy.merchantAllowList.map((m) => m.toLowerCase());
  if (!allowList.includes(merchant)) {
    deny(`merchant "${req.merchant}" is not on the allow-list (${allowList.join(", ")})`);
  } else {
    reasons.push(`merchant "${merchant}" is allow-listed`);
  }

  const capRaw = Object.prototype.hasOwnProperty.call(policy.categoryCapsInr, req.category)
    ? policy.categoryCapsInr[req.category]
    : undefined;
  if (capRaw === undefined) {
    deny(`category "${req.category}" is not allowed (allowed: ${Object.keys(policy.categoryCapsInr).join(", ")})`);
  }

  if (allowed) {
    if (amount > policy.perTxMaxInr) {
      deny(`₹${amount} is above the per-purchase cap of ₹${policy.perTxMaxInr}`);
    }
    if (spent + amount > policy.dailyBudgetInr) {
      deny(`₹${amount} would exceed the daily budget: ₹${spent} spent of ₹${policy.dailyBudgetInr}, ₹${remainingBefore} left`);
    } else {
      reasons.push(`daily budget ok: ₹${spent} + ₹${amount} ≤ ₹${policy.dailyBudgetInr}`);
    }
    const cap = capRaw as number;
    const catSpent = spentToday(policy, ledger, now, req.category);
    if (catSpent + amount > cap) {
      deny(`₹${amount} would exceed the ${req.category} cap: ₹${catSpent} spent of ₹${cap}`);
    } else {
      reasons.push(`${req.category} cap ok: ₹${catSpent} + ₹${amount} ≤ ₹${cap}`);
    }
  }

  const needsHuman = allowed && amount > policy.confirmAboveInr;
  if (needsHuman) reasons.push(`₹${amount} is above the auto-approve limit of ₹${policy.confirmAboveInr}: a human must confirm`);
  else if (allowed) reasons.push(`₹${amount} is within the auto-approve limit of ₹${policy.confirmAboveInr}`);

  return {
    allowed,
    needsHuman,
    reasons,
    spentTodayInr: spent,
    remainingInr: remainingBefore,
  };
}
