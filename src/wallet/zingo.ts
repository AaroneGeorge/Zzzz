// zingo-cli adapter — the REAL testnet path for ZecRecharge (Fallback A turned primary,
// because zecli has no testnet backend). zingo-cli runs in Docker via scripts/wallet-zingo.sh
// against the testnet lightwalletd https://testnet.zec.rocks:443. Wallet = the BIP39 mnemonic
// in .secrets/zcash_mnemonic.txt (same Orchard key zcli derives with --mnemonic).
//
// Why a REPL driver: in this zingo-cli build `--waitsync <cmd>` never returns (the sync task
// never reports completion), but the interactive prompt works fine over a stdin pipe. So each
// operation starts one session, polls `sync status` until the scan reaches the tip, runs the
// command(s), then `quit`s. Commands used (all print JSON):
//   addresses          -> [{ encoded_address, has_orchard, ... }]
//   sync status        -> { scan_ranges: [{priority,start_block,end_block}], sync_start_height, ... }
//   spendable_balance  -> { spendable_balance: <zat> }
//   quicksend <to> <zat> "<memo>" -> { txids: [..], transmissions: [..] }
//   notes              -> [{ value, status, spend_status, memo, txid, ... }] (received incl. self/change)
import { join } from "node:path";
import type { ShieldedSend } from "../types";
import type { MemoEntry, Network, Wallet } from "./types";
import { WalletError } from "./types";
import { assertSendArgs, explorerConfirmations, explorerUrl, sleep } from "./util";

export interface ReplProc {
  write(line: string): void;
  kill(): void;
  exited: Promise<number>;
}
/** Starts zingo-cli in interactive mode. Injected so tests can fake the CLI. */
export type ReplSpawner = (argv: string[], onStdout: (s: string) => void, onStderr: (s: string) => void) => ReplProc;

export const bunReplSpawner: ReplSpawner = (argv, onStdout, onStderr) => {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: APP_DIR });
  const pump = async (stream: ReadableStream<Uint8Array>, cb: (s: string) => void) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) cb(dec.decode(chunk, { stream: true }));
  };
  void pump(proc.stdout, onStdout);
  void pump(proc.stderr, onStderr);
  return {
    write: (line) => {
      proc.stdin.write(line.endsWith("\n") ? line : line + "\n");
      proc.stdin.flush();
    },
    kill: () => proc.kill(9),
    exited: proc.exited,
  };
};

/** Extract the first complete top-level JSON value that starts a line. Returns [value, restOfBuffer] or null. */
export function takeJson(buf: string): [unknown, string] | null {
  let from = 0;
  for (;;) {
    const m = /(^|\n)[ \t]*([{[])/g;
    m.lastIndex = from;
    const hit = m.exec(buf);
    if (!hit) return null;
    const start = hit.index + hit[0].length - 1;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < buf.length; i++) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          try {
            return [JSON.parse(buf.slice(start, i + 1)), buf.slice(i + 1)];
          } catch {
            break; // not JSON (e.g. the "[ confirmed_..." balance text); look further on
          }
        }
      }
    }
    if (depth > 0 && !inStr) return null; // incomplete: wait for more output
    from = start + 1;
  }
}

/** One interactive zingo-cli session. */
export class ZingoSession {
  private out = "";
  private err = "";
  private waiter: (() => void) | null = null;
  private proc: ReplProc;
  private closed = false;

  constructor(argv: string[], spawner: ReplSpawner) {
    this.proc = spawner(
      argv,
      (s) => {
        this.out += s;
        this.waiter?.();
      },
      (s) => {
        this.err += s;
        this.waiter?.();
      },
    );
    this.proc.exited.then(() => {
      this.closed = true;
      this.waiter?.();
    });
  }

  /** Send one REPL line and resolve with the JSON it prints. Rejects on an "Error" line or timeout. */
  async cmd<T>(line: string, timeoutMs: number): Promise<T> {
    this.err = "";
    this.proc.write(line);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const got = takeJson(this.out);
      if (got) {
        this.out = got[1];
        return got[0] as T;
      }
      const errLine = this.err.split("\n").find((l) => /^\s*(Error|error)\b/.test(l));
      if (errLine) throw new WalletError(`zingo-cli "${line.split(" ")[0]}": ${errLine.trim()}`, this.err.slice(-1500));
      if (this.closed) throw new WalletError(`zingo-cli exited during "${line.split(" ")[0]}"`, (this.err + this.out).slice(-1500));
      const left = deadline - Date.now();
      if (left <= 0) throw new WalletError(`zingo-cli "${line.split(" ")[0]}" timed out`, (this.err + this.out).slice(-1500));
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 1000));
        this.waiter = () => {
          clearTimeout(t);
          r();
        };
      });
      this.waiter = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      this.proc.write("quit");
    } catch {
      /* stdin gone */
    }
    const t = setTimeout(() => this.proc.kill(), 30_000);
    await this.proc.exited;
    clearTimeout(t);
  }
}

export interface ZingoOptions {
  /** argv prefix that runs zingo-cli for testnet with the wallet dir; default scripts/wallet-zingo.sh (env ZINGO_CMD) */
  cmd?: string[];
  network?: Network;
  spawner?: ReplSpawner;
  fetchImpl?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  pollMs?: number;
  syncTimeoutMs?: number;
  syncPollMs?: number;
  /** wallet data dir to lock across processes (default: the agent wallet dir when running the real CLI) */
  lockDir?: string | null;
}

type SyncStatus = { scan_ranges?: Array<{ priority?: string; start_block?: string | number; end_block?: string | number }>; sync_start_height?: number };
type ZingoNote = { value?: number; status?: string; spend_status?: string; memo?: string | null; txid?: string };

const APP_DIR = join(import.meta.dir, "..", "..");

/** `notes all` prints { ironwood_notes: { note_summaries: [...] }, orchard_notes: {...}, sapling_notes: {...} }. */
export function flattenNotes(n: unknown): ZingoNote[] {
  if (Array.isArray(n)) return n as ZingoNote[];
  if (!n || typeof n !== "object") return [];
  return Object.values(n as Record<string, unknown>).flatMap((pool) => {
    if (Array.isArray(pool)) return pool as ZingoNote[];
    const s = (pool as { note_summaries?: unknown })?.note_summaries;
    return Array.isArray(s) ? (s as ZingoNote[]) : [];
  });
}

/** Synced = this session's sync has learned the tip and every scan range up to it is Scanned. */
export function isSynced(s: SyncStatus): boolean {
  const start = Number(s.sync_start_height ?? 0);
  const ranges = s.scan_ranges ?? [];
  if (start <= 0 || ranges.length === 0) return false;
  if (!ranges.every((r) => r.priority === "Scanned")) return false;
  return Math.max(...ranges.map((r) => Number(r.end_block ?? 0))) >= start;
}

export class ZingoWallet implements Wallet {
  readonly mode = "zingo" as const;
  readonly network: Network;
  private cmd: string[];
  private spawner: ReplSpawner;
  private fetchImpl: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;
  private pollMs: number;
  private syncTimeoutMs: number;
  private syncPollMs: number;
  /** Serialise sessions: zingo-cli owns the wallet file; two concurrent sessions would race. */
  private queue: Promise<unknown> = Promise.resolve();
  private lockDir: string | null;

  constructor(opts: ZingoOptions = {}) {
    const env = process.env;
    this.network = opts.network ?? ((env.ZEC_NETWORK as Network) || "testnet");
    this.cmd = opts.cmd ?? (env.ZINGO_CMD ? env.ZINGO_CMD.split(" ").filter(Boolean) : [join(APP_DIR, "scripts", "wallet-zingo.sh")]);
    this.spawner = opts.spawner ?? bunReplSpawner;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepFn = opts.sleepFn ?? sleep;
    this.pollMs = opts.pollMs ?? 20_000;
    this.syncTimeoutMs = opts.syncTimeoutMs ?? 10 * 60_000;
    this.syncPollMs = opts.syncPollMs ?? 3_000;
    if (this.network !== "testnet") throw new WalletError("zingo adapter is wired for testnet only");
    this.lockDir = opts.lockDir !== undefined ? opts.lockDir : opts.spawner ? null : env.ZINGO_DATA_DIR || join(APP_DIR, ".secrets", "zingo-testnet");
  }

  /** Run `fn` inside one REPL session (synced first unless nosync). */
  private session<T>(fn: (s: ZingoSession) => Promise<T>, { nosync = false } = {}): Promise<T> {
    const job = this.queue.then(async () => {
      const release = this.lockDir ? await acquireLock(this.lockDir, this.sleepFn) : () => {};
      try {
      const s = new ZingoSession([...this.cmd, ...(nosync ? ["--nosync"] : [])], this.spawner);
      try {
        if (!nosync) {
          const deadline = Date.now() + this.syncTimeoutMs;
          for (;;) {
            const st = await s.cmd<SyncStatus>("sync status", 60_000);
            if (isSynced(st)) break;
            if (Date.now() > deadline) throw new WalletError("zingo-cli: sync did not reach the tip in time", st);
            await this.sleepFn(this.syncPollMs);
          }
        }
        return await fn(s);
      } finally {
        await s.close();
      }
      } finally {
        release();
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async getAddress(): Promise<string> {
    return this.session(async (s) => {
      const list = await s.cmd<Array<{ encoded_address?: string; has_orchard?: boolean }>>("addresses", 60_000);
      const a = list.find((x) => x.has_orchard !== false && x.encoded_address) ?? list[0];
      if (!a?.encoded_address) throw new WalletError("zingo-cli addresses: none", list);
      return a.encoded_address;
    }, { nosync: true });
  }

  async getBalance(): Promise<{ spendableZat: number }> {
    return this.session(async (s) => {
      const b = await s.cmd<{ spendable_balance?: number }>("spendable_balance", 60_000);
      return { spendableZat: Number(b.spendable_balance ?? 0) };
    });
  }

  async send(to: string, amountZat: number, memo: string): Promise<ShieldedSend> {
    assertSendArgs(to, amountZat, memo);
    if (!/^[A-Za-z0-9]+$/.test(to)) throw new WalletError("send: recipient must be a bech32/base58 address");
    if (/[\n\r"\\]/.test(memo)) throw new WalletError('send: memo may not contain newlines, quotes or backslashes');
    const r = await this.session((s) => s.cmd<{ txids?: string[] }>(`quicksend ${to} ${amountZat} "${memo}"`, 5 * 60_000));
    const txid = r.txids?.[0];
    if (!txid || !/^[0-9a-f]{64}$/i.test(txid)) throw new WalletError("zingo-cli quicksend: no txid", r);
    return {
      txid,
      network: this.network,
      amountZat,
      to,
      memo,
      confirmed: false,
      explorerUrl: explorerUrl(txid, this.network),
      mode: "zingo",
    };
  }

  /** Notes this wallet holds (received, self-sends and change), with decrypted memos. */
  async notes(): Promise<ZingoNote[]> {
    return this.session(async (s) => flattenNotes(await s.cmd<unknown>("notes all", 120_000)));
  }

  async waitConfirmed(txid: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Independent public check (cheap); fall back to our own wallet's view if the explorer is unreachable.
      const c = await explorerConfirmations(txid, this.network, this.fetchImpl);
      if ((c ?? 0) > 0) return true;
      if (c === null) {
        const notes = await this.notes().catch(() => [] as ZingoNote[]);
        if (notes.some((n) => n.txid === txid && /\bconfirmed/i.test(n.status ?? "") && !/unconfirmed|pending|mempool/i.test(n.status ?? ""))) return true;
      }
      if (Date.now() + this.pollMs > deadline) return false;
      await this.sleepFn(this.pollMs);
    }
  }

  async readMemos(): Promise<MemoEntry[]> {
    const out: MemoEntry[] = [];
    for (const n of await this.notes()) {
      const memo = typeof n.memo === "string" ? n.memo.replace(/\0+$/, "").trim() : "";
      if (!n.txid || !memo) continue;
      const h = /height (\d+)/.exec(n.status ?? "");
      out.push({ txid: n.txid, memo, amountZat: n.value, height: h ? Number(h[1]) : undefined });
    }
    return out;
  }
}

/**
 * Cross-process lock (mkdir is atomic): only one zingo-cli session may own a wallet dir, even when the web
 * server and the CLI run at the same time. A lock older than 10 minutes is treated as stale.
 */
export async function acquireLock(dir: string, sleepFn: (ms: number) => Promise<void> = sleep, maxWaitMs = 15 * 60_000): Promise<() => void> {
  const { mkdirSync, rmSync, statSync, existsSync } = await import("node:fs");
  if (!existsSync(dir)) return () => {};
  const lock = join(dir, ".zr-session.lock");
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* vanished between calls */
      }
      if (Date.now() > deadline) throw new WalletError(`zingo wallet ${dir} is busy (another ZecRecharge process holds ${lock})`);
      await sleepFn(1000);
    }
  }
}
