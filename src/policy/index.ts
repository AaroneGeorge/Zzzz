import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "./types";

export * from "./types";
export * from "./evaluate";
export * from "./hash";
export * from "./ledger";
export * from "./gate";

export const APP_ROOT = join(import.meta.dir, "..", "..");
export const DEFAULT_POLICY_PATH = join(APP_ROOT, "data", "policy.json");
export const DEFAULT_LEDGER_PATH = join(APP_ROOT, "data", "ledger.jsonl");

/** Load and validate a policy file. Throws on anything malformed: a broken mandate must not run. */
export function loadPolicy(path = process.env.POLICY_PATH || DEFAULT_POLICY_PATH): Policy {
  const p = JSON.parse(readFileSync(path, "utf8")) as Policy;
  const num = (k: keyof Policy) => {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`policy ${path}: ${String(k)} must be a non-negative number`);
  };
  num("dailyBudgetInr");
  num("perTxMaxInr");
  num("confirmAboveInr");
  if (!Array.isArray(p.merchantAllowList)) throw new Error(`policy ${path}: merchantAllowList must be an array`);
  if (!p.categoryCapsInr || typeof p.categoryCapsInr !== "object") throw new Error(`policy ${path}: categoryCapsInr missing`);
  if (!p.timezone) p.timezone = "Asia/Kolkata";
  return p;
}
