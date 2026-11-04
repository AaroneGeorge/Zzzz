import type { CommandRunner, Network, RunOptions, RunResult } from "./types";
import { WalletError } from "./types";

export const ZAT_PER_ZEC = 100_000_000;
/** ZIP-302: a memo field is 512 bytes. */
export const MAX_MEMO_BYTES = 512;

export function explorerUrl(txid: string, network: Network): string {
  return network === "testnet"
    ? `https://testnet.zcashexplorer.app/transactions/${txid}`
    : `https://mainnet.zcashexplorer.app/transactions/${txid}`;
}

/** Exact zatoshi -> "0.00100000" string (no float rounding). */
export function zatToZec(zat: number): string {
  if (!Number.isSafeInteger(zat) || zat < 0) throw new WalletError(`bad zatoshi amount: ${zat}`);
  const whole = Math.floor(zat / ZAT_PER_ZEC);
  const frac = String(zat % ZAT_PER_ZEC).padStart(8, "0");
  return `${whole}.${frac}`;
}

/** "0.001" -> 100000 (exact, string based). */
export function zecToZat(zec: string | number): number {
  const s = typeof zec === "number" ? zec.toFixed(8) : zec.trim();
  const m = /^(\d+)(?:\.(\d{0,8}))?$/.exec(s);
  if (!m) throw new WalletError(`bad ZEC amount: ${zec}`);
  return Number(m[1]) * ZAT_PER_ZEC + Number((m[2] ?? "").padEnd(8, "0"));
}

/** ZecRecharge memo convention: ZR1|<invoice_id>|<policy_hash8>. */
export function formatMemo(invoiceId: string, policyHash: string): string {
  return `ZR1|${invoiceId}|${policyHash.slice(0, 8)}`;
}

export function parseMemo(memo: string): { invoiceId: string; hash8: string } | null {
  const m = /^ZR1\|([^|]+)\|([0-9a-fA-F]{8})$/.exec(memo.trim());
  return m ? { invoiceId: m[1]!, hash8: m[2]! } : null;
}

export function assertSendArgs(to: string, amountZat: number, memo: string): void {
  if (!to || typeof to !== "string") throw new WalletError("send: missing recipient");
  if (!Number.isSafeInteger(amountZat) || amountZat <= 0) throw new WalletError(`send: bad amountZat ${amountZat}`);
  if (new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) throw new WalletError("send: memo longer than 512 bytes");
}

export function isShieldedAddress(addr: string): boolean {
  return /^(u1|utest1|zs1|ztestsapling1)/.test(addr);
}

/** Parse the last JSON value printed on stdout (CLIs may print banners/progress first). */
export function parseJsonOutput<T = unknown>(stdout: string): T {
  const text = stdout.trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    /* fall through */
  }
  // Banners may come before and after the JSON (zingo-cli prints "Launching save task..." /
  // "Save task shutdown..."). Find the earliest, longest line range that parses.
  const lines = text.split("\n");
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith("{") || t.startsWith("[")) starts.push(i);
    if (t.endsWith("}") || t.endsWith("]")) ends.push(i);
  });
  for (const i of starts) {
    for (let k = ends.length - 1; k >= 0 && ends[k]! >= i; k--) {
      try {
        return JSON.parse(lines.slice(i, ends[k]! + 1).join("\n")) as T;
      } catch {
        /* keep looking */
      }
    }
  }
  throw new WalletError("could not parse JSON from command output", stdout.slice(-500));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Real command runner using Bun.spawn. Never logs env (it may hold a seed). */
export const bunRunner: CommandRunner = async (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...(opts.env ?? {}) })) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs) timer = setTimeout(() => proc.kill(), opts.timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
};

/**
 * Read confirmations from the public testnet explorer (HTML scrape; no API key).
 * Returns null if the page could not be read. Used by the manual wallet and as an
 * independent check that a txid really exists on chain.
 */
export async function explorerConfirmations(
  txid: string,
  network: Network,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const res = await fetchImpl(explorerUrl(txid, network), {
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) ZecRecharge/0.1" },
    });
    if (!res.ok) return null;
    const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const m = /Confirmations\s+(\d+)/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
