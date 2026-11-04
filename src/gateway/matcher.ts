// Pure matcher: does the gateway hold a note that pays this invoice?
import { parseMemo } from "../wallet/util";
import type { GatewayNote } from "./types";

export interface Expectation {
  invoiceId: string;
  minZat: number;
  /** require the note to be mined (default true) */
  requireMined?: boolean;
}

/** Memo matches when it is a ZR1 memo for exactly this invoice id (policy hash may be anything). */
export function memoMatches(memo: string, invoiceId: string): boolean {
  const clean = memo.replace(/\0+$/, "").trim();
  const p = parseMemo(clean);
  return p !== null && p.invoiceId === invoiceId;
}

/**
 * Returns the best matching note, or null. Several outputs of the same tx with the right memo are summed
 * (a wallet may split one payment); amount must reach minZat.
 */
export function findPayment(notes: GatewayNote[], exp: Expectation): GatewayNote | null {
  const requireMined = exp.requireMined ?? true;
  const byTx = new Map<string, GatewayNote>();
  for (const n of notes) {
    if (!n.txid || !memoMatches(n.memo, exp.invoiceId)) continue;
    const prev = byTx.get(n.txid);
    byTx.set(n.txid, prev ? { ...prev, valueZat: prev.valueZat + n.valueZat, mined: prev.mined && n.mined, height: prev.height ?? n.height } : { ...n });
  }
  const ok = [...byTx.values()].filter((n) => n.valueZat >= exp.minZat && (!requireMined || n.mined));
  ok.sort((a, b) => (a.height ?? Infinity) - (b.height ?? Infinity));
  return ok[0] ?? null;
}

/** A matching memo that is not (yet) acceptable: in mempool, or underpaid. For progress messages. */
export function findPending(notes: GatewayNote[], invoiceId: string): GatewayNote | null {
  return notes.find((n) => memoMatches(n.memo, invoiceId)) ?? null;
}
