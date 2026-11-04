// zecli (`zcli`, rotko.net) adapter. Talks to a zidecar gRPC server.
//
// STATUS 2026-11-04: works for key derivation/addresses on testnet, but there is no public
// TESTNET zidecar: zcash.rotko.net is mainnet and has retired the GetHeaderProof RPC that
// zcli 0.6.0 (the last build with --testnet) needs; zcli 0.10.0 is mainnet-only.
// So on testnet this adapter fails at sync/send unless ZCLI_ENDPOINT points at a testnet
// zidecar you run yourself. See docs/zcash-leg.md. The real testnet path is zingo.ts.
import { existsSync, readFileSync } from "node:fs";
import type { ShieldedSend } from "../types";
import type { CommandRunner, MemoEntry, Network, Wallet } from "./types";
import { WalletError } from "./types";
import { assertSendArgs, bunRunner, explorerUrl, parseJsonOutput, sleep, zatToZec } from "./util";

export type ZcliGrammar = "v06" | "v10";

export interface ZecliOptions {
  bin?: string; // default env ZCLI_BIN or "zcli"
  network?: Network; // default env ZEC_NETWORK or testnet
  identity?: string; // ssh ed25519 key path (env ZCLI_IDENTITY)
  mnemonicFile?: string; // BIP39 phrase file (env ZCLI_MNEMONIC_FILE); passed via env, never argv
  endpoint?: string; // zidecar endpoint (env ZCLI_ENDPOINT)
  verifyEndpoints?: string; // env ZCLI_VERIFY_ENDPOINTS ("" disables cross-checks)
  grammar?: ZcliGrammar; // v06 = flat commands + --testnet; v10 = `view`/`tx` groups, mainnet only
  runner?: CommandRunner;
  sleepFn?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

type ZcliError = { error: string };

export class ZecliWallet implements Wallet {
  readonly mode = "zecli" as const;
  readonly network: Network;
  private bin: string;
  private grammar: ZcliGrammar;
  private runner: CommandRunner;
  private sleepFn: (ms: number) => Promise<void>;
  private pollMs: number;
  private timeoutMs: number;
  private identity?: string;
  private mnemonicFile?: string;
  private endpoint?: string;
  private verifyEndpoints?: string;

  constructor(opts: ZecliOptions = {}) {
    const env = process.env;
    this.network = opts.network ?? ((env.ZEC_NETWORK as Network) || "testnet");
    this.bin = opts.bin ?? env.ZCLI_BIN ?? "zcli";
    this.grammar = opts.grammar ?? ((env.ZCLI_GRAMMAR as ZcliGrammar) || (this.network === "testnet" ? "v06" : "v10"));
    this.identity = opts.identity ?? env.ZCLI_IDENTITY ?? "./.secrets/zcash_ed25519";
    this.mnemonicFile = opts.mnemonicFile ?? env.ZCLI_MNEMONIC_FILE;
    this.endpoint = opts.endpoint ?? env.ZCLI_ENDPOINT;
    this.verifyEndpoints = opts.verifyEndpoints ?? env.ZCLI_VERIFY_ENDPOINTS;
    this.runner = opts.runner ?? bunRunner;
    this.sleepFn = opts.sleepFn ?? sleep;
    this.pollMs = opts.pollMs ?? 15_000;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    if (this.grammar === "v10" && this.network === "testnet") {
      throw new WalletError("zcli >= 0.10 is mainnet-only; use ZCLI_GRAMMAR=v06 with zcli 0.6.0 for testnet");
    }
  }

  /** argv for one command; global flags go before the subcommand (works for both grammars). */
  argv(cmd: string[]): string[] {
    const a = [this.bin, "--json"];
    if (this.grammar === "v06") a.push(this.network === "testnet" ? "--testnet" : "--mainnet");
    if (!this.mnemonicFile && this.identity) a.push("-i", this.identity);
    if (this.endpoint) a.push("--endpoint", this.endpoint);
    return [...a, ...cmd];
  }

  private cmd(name: "address" | "balance" | "sync" | "send" | "notes" | "history"): string[] {
    if (this.grammar === "v06") return [name];
    const map = { address: ["view", "address"], balance: ["view", "balance"], sync: ["init", "sync"], send: ["tx", "send"], notes: ["view", "notes"], history: ["view", "history"] } as const;
    return [...map[name]];
  }

  private env(): Record<string, string | undefined> {
    const e: Record<string, string | undefined> = { ZCLI_JSON: "true" };
    if (this.mnemonicFile) {
      if (!existsSync(this.mnemonicFile)) throw new WalletError(`mnemonic file not found: ${this.mnemonicFile}`);
      e.ZCLI_MNEMONIC = readFileSync(this.mnemonicFile, "utf8").trim();
    }
    if (this.verifyEndpoints !== undefined) e.ZCLI_VERIFY_ENDPOINTS = this.verifyEndpoints;
    return e;
  }

  private async run<T>(cmd: string[], timeoutMs = this.timeoutMs): Promise<T> {
    const argv = this.argv(cmd);
    const r = await this.runner(argv, { env: this.env(), timeoutMs });
    let out: T | ZcliError;
    try {
      out = parseJsonOutput<T | ZcliError>(r.stdout);
    } catch {
      throw new WalletError(`zcli ${cmd.join(" ")} failed (exit ${r.code})`, (r.stderr || r.stdout).slice(-800));
    }
    if (out && typeof out === "object" && !Array.isArray(out) && "error" in out && typeof (out as ZcliError).error === "string") {
      throw new WalletError(`zcli ${cmd.join(" ")}: ${(out as ZcliError).error}`);
    }
    if (r.code !== 0) throw new WalletError(`zcli ${cmd.join(" ")} exit ${r.code}`, r.stderr.slice(-800));
    return out as T;
  }

  async getAddress(): Promise<string> {
    const out = await this.run<{ orchard?: string; address?: string; unified?: string }>(this.cmd("address"), 60_000);
    const addr = out.orchard ?? out.unified ?? out.address;
    if (!addr) throw new WalletError("zcli address: no orchard address in output", out);
    return addr;
  }

  async sync(): Promise<void> {
    await this.run(this.cmd("sync"));
  }

  async getBalance(): Promise<{ spendableZat: number }> {
    await this.sync();
    const b = await this.run<{ shielded?: number; total?: number }>(this.cmd("balance"));
    return { spendableZat: Number(b.shielded ?? 0) };
  }

  async send(to: string, amountZat: number, memo: string): Promise<ShieldedSend> {
    assertSendArgs(to, amountZat, memo);
    await this.sync();
    const r = await this.run<{ txid?: string; success?: boolean; error?: string | null }>([
      ...this.cmd("send"),
      zatToZec(amountZat),
      to,
      "--memo",
      memo,
    ]);
    if (!r.txid || r.success === false) throw new WalletError(`zcli send failed: ${r.error ?? "no txid"}`, r);
    return {
      txid: r.txid,
      network: this.network,
      amountZat,
      to,
      memo,
      confirmed: false,
      explorerUrl: explorerUrl(r.txid, this.network),
      mode: "zecli",
    };
  }

  async waitConfirmed(txid: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.sync();
      const hist = await this.run<Array<{ txid?: string; height?: number }>>(this.cmd("history"));
      if (hist.some((h) => h.txid === txid && Number(h.height) > 0)) return true;
      if (Date.now() + this.pollMs > deadline) return false;
      await this.sleepFn(this.pollMs);
    }
  }

  async readMemos(): Promise<MemoEntry[]> {
    await this.sync();
    const notes = await this.run<Array<{ txid?: string; memo?: string; zat?: number; height?: number }>>(this.cmd("notes"));
    return notes
      .filter((n) => n.txid && typeof n.memo === "string" && n.memo.length > 0)
      .map((n) => ({ txid: n.txid!, memo: n.memo!, amountZat: n.zat, height: n.height }));
  }
}
