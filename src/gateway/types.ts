// Shielded payment gateway (merchant side). The agent pays the gateway's unified address; the gateway
// watches its own wallet (view-only UFVK wallet by default) and only a verified payment unlocks the order.

/** How the gateway sees incoming notes. */
export type GatewayView =
  | "ufvk" // view-only zingo wallet imported from the gateway's unified full viewing key (cannot spend)
  | "wallet" // the gateway's own full (spending) zingo wallet
  | "mock"; // in-memory, never a chain transaction

/** One received shielded note, as decrypted by the gateway's key. */
export interface GatewayNote {
  txid: string;
  memo: string;
  valueZat: number;
  /** block height when mined; undefined while in the mempool */
  height?: number;
  mined: boolean;
}

/** Something that lists the notes the gateway has received. */
export interface NoteSource {
  listNotes(): Promise<GatewayNote[]>;
}

/** A payment request issued by the gateway for one purchase. */
export interface GatewayInvoice {
  id: string;
  address: string;
  amountZat: number;
  memo: string;
  network: "testnet";
  createdAt: string;
  /** quoted mainnet ZEC for the real price (NEAR Intents dry quote), when known */
  quotedMainnetZec?: string;
  /** how amountZat was derived from the quote (honest label for the UI) */
  pricing: string;
}

export interface GatewayVerification {
  verified: true;
  invoiceId: string;
  txid: string;
  height?: number;
  amountZat: number;
  memo: string;
  view: GatewayView;
  verifiedAt: string;
  polls: number;
}

export interface WaitProgress {
  polls: number;
  elapsedMs: number;
  /** a matching note was seen but is not mined yet */
  inMempool?: GatewayNote;
  lastError?: string;
}

export class GatewayTimeout extends Error {
  constructor(message: string, readonly progress: WaitProgress) {
    super(message);
    this.name = "GatewayTimeout";
  }
}
