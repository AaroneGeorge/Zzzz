// NoteSource backed by a zingo-cli wallet dir (view-only UFVK wallet or the gateway's full wallet).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZingoWallet, type ZingoOptions } from "../wallet/zingo";
import type { GatewayNote, NoteSource } from "./types";

const APP_DIR = join(import.meta.dir, "..", "..");
export const GATEWAY_VIEW_DIR = join(APP_DIR, ".secrets", "zingo-gateway-view");
export const GATEWAY_WALLET_DIR = join(APP_DIR, ".secrets", "zingo-gateway");

type RawNote = { value?: number; status?: string; memo?: string | null; txid?: string; height?: number; block_height?: number; mined_height?: number };

/** zingo note status → mined + height. Status looks like "confirmed at height 4582147" or "pending/mempool ...". */
export function toGatewayNote(n: RawNote): GatewayNote | null {
  if (!n.txid) return null;
  const status = String(n.status ?? "");
  const h = /height\D{0,3}(\d+)/i.exec(status);
  const height = n.height ?? n.block_height ?? n.mined_height ?? (h ? Number(h[1]) : undefined);
  const mined = /confirmed/i.test(status) && !/unconfirmed|pending|mempool|transmitted|calculated/i.test(status);
  const memo = typeof n.memo === "string" ? n.memo.replace(/\0+$/, "").trim() : "";
  return { txid: n.txid, memo, valueZat: Number(n.value ?? 0), height: mined ? height : undefined, mined };
}

export class ZingoNoteSource implements NoteSource {
  private wallet: ZingoWallet;
  constructor(readonly dataDir: string, opts: ZingoOptions = {}) {
    if (!existsSync(dataDir)) throw new Error(`gateway wallet dir missing: ${dataDir}`);
    // wallet-zingo.sh reads ZINGO_DATA_DIR; ZINGO_SEED= keeps it from ever restoring the agent seed into this dir.
    const cmd = opts.cmd ?? ["env", `ZINGO_DATA_DIR=${dataDir}`, "ZINGO_SEED=", join(APP_DIR, "scripts", "wallet-zingo.sh")];
    this.wallet = new ZingoWallet({ syncTimeoutMs: 3 * 60_000, lockDir: opts.spawner ? null : dataDir, ...opts, cmd });
  }
  async listNotes(): Promise<GatewayNote[]> {
    const raw = (await this.wallet.notes()) as RawNote[];
    return raw.map(toGatewayNote).filter((x): x is GatewayNote => x !== null);
  }
}
