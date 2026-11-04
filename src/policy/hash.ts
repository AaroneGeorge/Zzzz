import { createHash } from "node:crypto";
import type { Policy } from "./types";

/** JSON with object keys sorted at every level, so the hash does not depend on key order or whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** Full sha256 (hex) of the canonical policy. */
export function policyHash(policy: Policy): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

/** The 8-hex prefix used in memos. */
export function hash8(policy: Policy | string): string {
  const h = typeof policy === "string" ? policy : policyHash(policy);
  return h.slice(0, 8);
}

/** Shielded memo: ZR1|<invoice_id>|<hash8>. Fits easily in the 512-byte Zcash memo. */
export function buildMemo(invoiceId: string, policy: Policy | string): string {
  if (!invoiceId || /[|\n]/.test(invoiceId)) throw new Error(`bad invoice id for memo: ${JSON.stringify(invoiceId)}`);
  return `ZR1|${invoiceId}|${hash8(policy)}`;
}

export function parseMemo(memo: string): { invoiceId: string; hash8: string } | null {
  const m = /^ZR1\|([^|\n]+)\|([0-9a-f]{8})$/.exec(memo.trim());
  return m ? { invoiceId: m[1]!, hash8: m[2]! } : null;
}
