// Gateway factory + pricing. GATEWAY_MODE=ufvk|wallet|mock (default: ufvk when ZEC_WALLET=zingo, else mock).
//   ufvk   - REAL: view-only zingo wallet imported from the gateway's UFVK (.secrets/zingo-gateway-view). Cannot spend.
//   wallet - REAL: the gateway's own spending wallet (.secrets/zingo-gateway), if the UFVK wallet is unavailable.
//   mock   - in-memory: "sees" whatever the mock wallet sent. Never a chain transaction.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { GatewayInvoice, GatewayNote, GatewayVerification, GatewayView, NoteSource, WaitProgress } from "./types";
import { waitForPayment } from "./watcher";
import { GATEWAY_VIEW_DIR, GATEWAY_WALLET_DIR, ZingoNoteSource } from "./zingo-source";

export * from "./types";
export { findPayment, findPending, memoMatches } from "./matcher";
export { waitForPayment } from "./watcher";
export { toGatewayNote, ZingoNoteSource } from "./zingo-source";

/** The gateway's unified address (testnet). Same UA for the full and the view-only wallet. */
export const GATEWAY_UA_DEFAULT =
  "utest1u2fv2k87x7370mw88j3hst9cd4qnz9cw3pya2xu4h80u6zwms25qcn6zfw5909wnpnws2l6rzf42z70lvn5d37wzz72ker9ak56w9yke";

export const VIEW_LABEL: Record<GatewayView, string> = {
  ufvk: "view-only wallet (UFVK imported into zingo-cli; it cannot spend)",
  wallet: "gateway's own full wallet (UFVK import unavailable)",
  mock: "MOCK gateway (in-memory; nothing on chain)",
};

export interface Gateway {
  readonly view: GatewayView;
  readonly address: string;
  createInvoice(o: { runTag: string; amountZat: number; memoFor: (id: string) => string; quotedMainnetZec?: string; pricing: string }): GatewayInvoice;
  waitForPayment(inv: GatewayInvoice, o: { timeoutMs?: number; pollMs?: number; onProgress?: (p: WaitProgress) => void; sent?: { txid: string; amountZat: number; memo: string; to: string } }): Promise<GatewayVerification>;
}

export class SourceGateway implements Gateway {
  constructor(
    readonly view: GatewayView,
    readonly address: string,
    private source: NoteSource,
    private defaults: { timeoutMs: number; pollMs: number; requireMined: boolean },
  ) {}
  createInvoice(o: { runTag: string; amountZat: number; memoFor: (id: string) => string; quotedMainnetZec?: string; pricing: string }): GatewayInvoice {
    const id = `zrg-${o.runTag}-${randomBytes(3).toString("hex")}`;
    return { id, address: this.address, amountZat: o.amountZat, memo: o.memoFor(id), network: "testnet", createdAt: new Date().toISOString(), quotedMainnetZec: o.quotedMainnetZec, pricing: o.pricing };
  }
  waitForPayment(inv: GatewayInvoice, o: { timeoutMs?: number; pollMs?: number; onProgress?: (p: WaitProgress) => void } = {}) {
    return waitForPayment(this.source, this.view, inv, {
      timeoutMs: o.timeoutMs ?? this.defaults.timeoutMs,
      pollMs: o.pollMs ?? this.defaults.pollMs,
      requireMined: this.defaults.requireMined,
      onProgress: o.onProgress,
    });
  }
}

/** Mock gateway: its notes are exactly what the (mock) agent wallet reported sending to it. */
export class MockGateway extends SourceGateway {
  readonly notes: GatewayNote[] = [];
  constructor(address = "utest1mockgatewaymockgatewaymockgatewaymockgatewaymockgateway") {
    const notes: GatewayNote[] = [];
    super("mock", address, { listNotes: async () => notes }, { timeoutMs: 1_000, pollMs: 10, requireMined: true });
    this.notes = notes;
  }
  override waitForPayment(inv: GatewayInvoice, o: Parameters<Gateway["waitForPayment"]>[1] = {}) {
    if (o.sent && o.sent.to === this.address) this.notes.push({ txid: o.sent.txid, memo: o.sent.memo, valueZat: o.sent.amountZat, mined: true, height: 1 });
    return super.waitForPayment(inv, { ...o, timeoutMs: o.timeoutMs ?? 1_000, pollMs: 10 });
  }
}

export function createGateway(env: Record<string, string | undefined> = process.env): Gateway {
  const walletKind = (env.ZEC_WALLET || "mock").trim();
  let mode = (env.GATEWAY_MODE || (walletKind === "zingo" ? "ufvk" : "mock")).trim() as GatewayView;
  if (mode === "mock") return new MockGateway();
  if (mode === "ufvk" && !existsSync(GATEWAY_VIEW_DIR)) mode = "wallet";
  const dir = mode === "ufvk" ? GATEWAY_VIEW_DIR : GATEWAY_WALLET_DIR;
  const address = env.GATEWAY_ADDRESS?.trim() || GATEWAY_UA_DEFAULT;
  return new SourceGateway(mode, address, new ZingoNoteSource(dir), {
    timeoutMs: Number(env.GATEWAY_TIMEOUT_MS || 12 * 60_000),
    pollMs: Number(env.GATEWAY_POLL_MS || 10_000),
    requireMined: env.GATEWAY_ACCEPT_MEMPOOL !== "1",
  });
}

/**
 * Testnet stand-in price. The real price is the quoted MAINNET ZEC (NEAR Intents dry quote); on testnet we send
 * quoted × GATEWAY_TESTNET_SCALE (default 1, i.e. the same number of TAZ), clamped to [0.001, 0.01] TAZ and rounded to 1,000 zat.
 */
export function testnetPriceZat(quotedZec: string | undefined, env: Record<string, string | undefined> = process.env): { amountZat: number; pricing: string } {
  const scale = Number(env.GATEWAY_TESTNET_SCALE || 1);
  const min = 100_000, max = 1_000_000;
  const q = Number(quotedZec);
  if (!quotedZec || !Number.isFinite(q) || q <= 0) {
    const z = Number(env.ZEC_TESTNET_SEND_ZAT || 100_000);
    return { amountZat: z, pricing: `no quote: fixed ${z / 1e8} TAZ testnet stand-in` };
  }
  const raw = Math.round((q * 1e8 * scale) / 1000) * 1000;
  const amountZat = Math.min(max, Math.max(min, raw));
  return { amountZat, pricing: `testnet stand-in: quoted ${q} ZEC (mainnet) × ${scale} = ${(amountZat / 1e8).toFixed(5)} TAZ${amountZat !== raw ? " (clamped to 0.001–0.01)" : ""}` };
}
