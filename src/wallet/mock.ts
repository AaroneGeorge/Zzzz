// In-memory wallet for tests and the offline demo. Every send it returns carries
// mode "mock", a txid starting with "mock-" and an explorer URL of "mock://..." so it can
// never be mistaken for a real chain transaction.
import { createHash } from "node:crypto";
import type { MemoEntry, Network, Wallet, WalletSend } from "./types";
import { WalletError } from "./types";
import { assertSendArgs } from "./util";

export const MOCK_ADDRESS =
  "utest1mockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmock";

export interface MockOptions {
  address?: string;
  balanceZat?: number;
  feeZat?: number;
  /** if true, sends to our own address show up in readMemos() (like a self-transfer) */
  network?: Network;
}

export class MockWallet implements Wallet {
  readonly mode = "mock" as const;
  readonly network: Network;
  private address: string;
  private balanceZat: number;
  private feeZat: number;
  private sent: WalletSend[] = [];
  private received: MemoEntry[] = [];
  private counter = 0;

  constructor(opts: MockOptions = {}) {
    this.network = opts.network ?? "testnet";
    this.address = opts.address ?? MOCK_ADDRESS;
    this.balanceZat = opts.balanceZat ?? 100_000_000;
    this.feeZat = opts.feeZat ?? 10_000;
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async getBalance(): Promise<{ spendableZat: number }> {
    return { spendableZat: this.balanceZat };
  }

  async send(to: string, amountZat: number, memo: string): Promise<WalletSend> {
    assertSendArgs(to, amountZat, memo);
    if (amountZat + this.feeZat > this.balanceZat) throw new WalletError("mock: insufficient funds");
    const txid = "mock-" + createHash("sha256").update(`${++this.counter}|${to}|${amountZat}|${memo}`).digest("hex").slice(0, 59);
    this.balanceZat -= amountZat + this.feeZat;
    if (to === this.address) {
      this.balanceZat += amountZat;
      this.received.push({ txid, memo, amountZat });
    }
    const s: WalletSend = {
      txid,
      network: this.network,
      amountZat,
      to,
      memo,
      confirmed: false,
      explorerUrl: `mock://${txid}`,
      mode: "mock",
    };
    this.sent.push(s);
    return s;
  }

  async waitConfirmed(txid: string, _timeoutMs: number): Promise<boolean> {
    const s = this.sent.find((x) => x.txid === txid);
    if (!s) return false;
    s.confirmed = true;
    return true;
  }

  async readMemos(): Promise<MemoEntry[]> {
    return [...this.received];
  }
}
