// Fallback B: a human sends TAZ from a mobile wallet (Zingo!/Zipher) with the memo, then
// sets WALLET_TXID_OVERRIDE=<txid>. send() returns that txid labelled mode "manual" —
// the app did NOT sign it. waitConfirmed() checks the public testnet explorer.
import type { ShieldedSend } from "../types";
import type { MemoEntry, Network, Wallet } from "./types";
import { WalletError } from "./types";
import { explorerConfirmations, explorerUrl, sleep } from "./util";

export interface ManualOptions {
  txid?: string; // default env WALLET_TXID_OVERRIDE
  address?: string; // default env ZEC_ADDRESS (the human's sending wallet), else ZEC_DEST_ADDRESS
  memo?: string; // default env WALLET_MEMO_OVERRIDE (the memo the human actually typed)
  network?: Network;
  fetchImpl?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  pollMs?: number;
}

const TXID_RE = /^[0-9a-f]{64}$/i;

export class ManualWallet implements Wallet {
  readonly mode = "manual" as const;
  readonly network: Network;
  private txid?: string;
  private address?: string;
  private memoOverride?: string;
  private lastSend?: ShieldedSend;
  private fetchImpl: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;
  private pollMs: number;

  constructor(opts: ManualOptions = {}) {
    const env = process.env;
    this.network = opts.network ?? ((env.ZEC_NETWORK as Network) || "testnet");
    this.txid = (opts.txid ?? env.WALLET_TXID_OVERRIDE)?.trim() || undefined;
    this.address = opts.address ?? (env.ZEC_ADDRESS || env.ZEC_DEST_ADDRESS || undefined);
    this.memoOverride = opts.memo ?? (env.WALLET_MEMO_OVERRIDE || undefined);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepFn = opts.sleepFn ?? sleep;
    this.pollMs = opts.pollMs ?? 15_000;
    if (this.txid && !TXID_RE.test(this.txid)) throw new WalletError("WALLET_TXID_OVERRIDE is not a 64-hex txid");
  }

  async getAddress(): Promise<string> {
    if (!this.address) throw new WalletError("manual wallet: set ZEC_ADDRESS to the human's shielded address");
    return this.address;
  }

  /** Unknown: the funds live in the human's phone wallet. */
  async getBalance(): Promise<{ spendableZat: number }> {
    return { spendableZat: 0 };
  }

  async send(to: string, amountZat: number, memo: string): Promise<ShieldedSend> {
    if (!this.txid) {
      throw new WalletError(
        `manual wallet: send ${amountZat} zat to ${to} with memo "${memo}" from a mobile wallet, then set WALLET_TXID_OVERRIDE=<txid>`,
      );
    }
    const confs = await explorerConfirmations(this.txid, this.network, this.fetchImpl);
    this.lastSend = {
      txid: this.txid,
      network: this.network,
      amountZat,
      to,
      memo: this.memoOverride ?? memo,
      confirmed: (confs ?? 0) > 0,
      explorerUrl: explorerUrl(this.txid, this.network),
      mode: "manual",
    };
    return this.lastSend;
  }

  async waitConfirmed(txid: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = await explorerConfirmations(txid, this.network, this.fetchImpl);
      if ((c ?? 0) > 0) return true;
      if (Date.now() + this.pollMs > deadline) return false;
      await this.sleepFn(this.pollMs);
    }
  }

  /** We hold no viewing key in manual mode; report the memo the human says they sent. */
  async readMemos(): Promise<MemoEntry[]> {
    if (!this.txid) return [];
    const memo = this.memoOverride ?? this.lastSend?.memo;
    return memo ? [{ txid: this.txid, memo }] : [];
  }
}
