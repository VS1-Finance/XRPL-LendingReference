import type { Wallet } from "xrpl";
import { decode, encode, DEFAULT_DEFINITIONS } from "ripple-binary-codec";
// signingData is NOT re-exported at the codec's package root (verified: codec.binary is undefined,
// codec.coreTypes is the TYPES namespace, not the binary one). It IS reachable via the deep subpath —
// the codec's package.json exports "dist/", so this import resolves. Verified end-to-end: signingData
// with the CPT prefix produces bytes beginning 0x43 0x50 0x54 0x00.
import { signingData } from "ripple-binary-codec/dist/binary.js";
import { sign as signKeypair } from "ripple-keypairs";

// The counterparty hash prefix that amendment fixCleanup3_4_0 requires on Devnet rc3+. Before that fix
// every signer covered the plain TxSign prefix ('STX' 0x53545800); after it, a LoanSet's counterparty
// must sign over 'CPT' (0x43505400 = HashPrefix::CounterpartyTxSign). Our pinned xrpl signs with the old
// TxSign prefix, so its signLoanSetByCounterparty produces a signature the ledger rejects as
// "Counterparty: Invalid signature". This helper signs over the correct prefix instead.
export const COUNTERPARTY_TX_SIGN_PREFIX = new Uint8Array([0x43, 0x50, 0x54, 0x00]);

// The hex signing data a LoanSet counterparty must sign, over the CPT prefix. Exported so tests can
// verify without re-deriving. `tx` is a decoded LoanSet object (already owner-signed). Note signingData
// serializes signing-fields-only, so the kNotSigning CounterpartySignature field is correctly excluded.
export function counterpartySigningDataHex(tx: Record<string, unknown>): string {
  const bytes: Uint8Array = signingData(tx as never, COUNTERPARTY_TX_SIGN_PREFIX as never, { definitions: DEFAULT_DEFINITIONS } as never);
  return Buffer.from(bytes).toString("hex").toUpperCase();
}

// Drop-in for xrpl's signLoanSetByCounterparty, but computing the counterparty signature over the CPT
// prefix (fixCleanup3_4_0). Takes the owner-signed LoanSet tx_blob, returns the fully-signed tx_blob.
export function signLoanSetByCounterpartyCPT(wallet: Wallet, ownerSignedBlob: string): { tx_blob: string } {
  const tx = decode(ownerSignedBlob) as Record<string, unknown>;
  if (tx.TransactionType !== "LoanSet") throw new Error("Transaction must be a LoanSet transaction.");
  if (tx.CounterpartySignature) throw new Error("Transaction is already signed by the counterparty.");
  if (tx.TxnSignature == null || tx.SigningPubKey == null) throw new Error("Transaction must be first signed by the owner.");
  const txnSignature = signKeypair(counterpartySigningDataHex(tx), wallet.privateKey);
  tx.CounterpartySignature = { SigningPubKey: wallet.publicKey, TxnSignature: txnSignature };
  return { tx_blob: encode(tx) };
}
