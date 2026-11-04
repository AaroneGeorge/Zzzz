// Polls a NoteSource until a note pays the invoice (memo + amount + mined) or the timeout passes.
import { findPayment, findPending } from "./matcher";
import type { GatewayInvoice, GatewayVerification, GatewayView, NoteSource, WaitProgress } from "./types";
import { GatewayTimeout } from "./types";

export interface WaitOpts {
  timeoutMs: number;
  pollMs: number;
  requireMined?: boolean;
  onProgress?: (p: WaitProgress) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForPayment(source: NoteSource, view: GatewayView, inv: GatewayInvoice, opts: WaitOpts): Promise<GatewayVerification> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  const progress: WaitProgress = { polls: 0, elapsedMs: 0 };
  for (;;) {
    progress.polls++;
    try {
      const notes = await source.listNotes();
      const hit = findPayment(notes, { invoiceId: inv.id, minZat: inv.amountZat, requireMined: opts.requireMined ?? true });
      if (hit) {
        return { verified: true, invoiceId: inv.id, txid: hit.txid, height: hit.height, amountZat: hit.valueZat, memo: hit.memo.replace(/\0+$/, "").trim(), view, verifiedAt: new Date().toISOString(), polls: progress.polls };
      }
      progress.inMempool = findPending(notes, inv.id) ?? undefined;
      progress.lastError = undefined;
    } catch (e) {
      progress.lastError = (e as Error).message;
    }
    progress.elapsedMs = now() - start;
    opts.onProgress?.({ ...progress });
    if (progress.elapsedMs + opts.pollMs > opts.timeoutMs) {
      throw new GatewayTimeout(
        `gateway saw no ${opts.requireMined ?? true ? "mined " : ""}payment of ≥ ${inv.amountZat} zat with memo for ${inv.id} within ${Math.round(opts.timeoutMs / 1000)} s${progress.inMempool ? " (a matching tx is still unconfirmed)" : ""}${progress.lastError ? ` · last error: ${progress.lastError}` : ""}`,
        { ...progress },
      );
    }
    await sleep(opts.pollMs);
  }
}
