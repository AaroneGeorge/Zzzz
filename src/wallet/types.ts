// Wallet-local types (T1). The shared contract lives in src/types.ts and is frozen;
// it has no "mock" mode for ShieldedSend, so the wallet widens it here instead of editing it.
import type { ShieldedSend } from "../types";

/** Which backend produced a send. "mock" is never a real chain transaction. */
export type WalletMode = ShieldedSend["mode"] | "mock";

/** ShieldedSend with `mode` widened to include "mock". Real backends return a plain ShieldedSend. */
export type WalletSend = Omit<ShieldedSend, "mode"> & { mode: WalletMode };

export type Network = ShieldedSend["network"];

export interface MemoEntry {
  txid: string;
  memo: string;
  /** zatoshis received by this wallet in that output, when the backend reports it */
  amountZat?: number;
  height?: number;
}

export interface Wallet {
  readonly mode: WalletMode;
  readonly network: Network;
  /** Our shielded (unified / Orchard) receiving address. */
  getAddress(): Promise<string>;
  getBalance(): Promise<{ spendableZat: number }>;
  /** Send `amountZat` to `to` with a text memo. Resolves once the tx is broadcast (not mined). */
  send(to: string, amountZat: number, memo: string): Promise<WalletSend>;
  /** Poll until the tx has >= 1 confirmation or the timeout passes. */
  waitConfirmed(txid: string, timeoutMs: number): Promise<boolean>;
  /** Memos of transactions this wallet received (decrypted locally). */
  readMemos(): Promise<MemoEntry[]>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  cwd?: string;
}

/** Runs an external command. Injected so tests can fake zcli / zingo-cli. */
export type CommandRunner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

export class WalletError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "WalletError";
  }
}
