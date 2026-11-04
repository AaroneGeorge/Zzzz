// Wallet factory. Pick the backend with env ZEC_WALLET=zingo|zecli|manual|mock (default mock).
//   zingo  - REAL testnet path today: zingo-cli in Docker (docker/zingo.Dockerfile) via scripts/wallet-zingo.sh
//   zecli  - zcli/zecli; addresses only on testnet (no public testnet zidecar), see docs/zcash-leg.md
//   manual - human sent from a phone wallet; txid from WALLET_TXID_OVERRIDE
//   mock   - in-memory; txids start with "mock-"; never a real payment
import { ManualWallet } from "./manual";
import { MockWallet } from "./mock";
import type { Wallet, WalletMode } from "./types";
import { WalletError } from "./types";
import { ZecliWallet } from "./zecli";
import { ZingoWallet } from "./zingo";

export * from "./types";
export { explorerUrl, formatMemo, parseMemo, zatToZec, zecToZat, explorerConfirmations } from "./util";
export { ManualWallet, MockWallet, ZecliWallet, ZingoWallet };

export function createWallet(kind: string | undefined = process.env.ZEC_WALLET): Wallet {
  const k = (kind || "mock").trim().toLowerCase() as WalletMode;
  if ((process.env.ZEC_NETWORK || "testnet") !== "testnet") {
    throw new WalletError("ZecRecharge is testnet-only: set ZEC_NETWORK=testnet");
  }
  switch (k) {
    case "zingo":
      return new ZingoWallet();
    case "zecli":
      return new ZecliWallet();
    case "manual":
      return new ManualWallet();
    case "mock":
      return new MockWallet();
    default:
      throw new WalletError(`unknown ZEC_WALLET=${kind} (use zingo|zecli|manual|mock)`);
  }
}
