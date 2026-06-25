import { readMemos, type Memo } from "@lending/shared";

// A transaction reduced to the fields the store needs. rippled decodes the new transaction types
// natively, so this maps the structured JSON — there is no binary parsing here.
export interface DecodedTransaction {
  txHash: string;
  txType: string;
  ledgerIndex: number;
  setupId?: string;
  correlationId?: string;
  raw: unknown;
  parsed: Record<string, unknown>;
}

// Pull the normalized fields out of a transaction node as delivered by the tx stream or account_tx.
// The setup and correlation ids come from the Memos the harness and lifecycle stamp on every
// transaction.
export function decodeTransaction(entry: TxStreamLike): DecodedTransaction | undefined {
  const txJson = entry.tx_json ?? entry.transaction ?? entry.tx;
  const hash = entry.hash ?? txJson?.hash;
  const meta = entry.meta ?? entry.metaData;
  if (!txJson || !hash) return undefined;

  const ledgerIndex = entry.ledger_index ?? txJson.ledger_index ?? 0;
  const memos = readMemos(txJson.Memos as Memo[] | undefined);

  const decoded: DecodedTransaction = {
    txHash: String(hash),
    txType: String(txJson.TransactionType ?? "unknown"),
    ledgerIndex: Number(ledgerIndex),
    raw: { tx: txJson, meta },
    parsed: txJson as Record<string, unknown>,
  };
  if (memos.setupId !== undefined) decoded.setupId = memos.setupId;
  if (memos.correlationId !== undefined) decoded.correlationId = memos.correlationId;
  return decoded;
}

// The shape of a transaction as it arrives from the tx stream or an account_tx page. Both carry
// the transaction body under slightly different keys across ledger versions, so all are accepted.
export interface TxStreamLike {
  hash?: string;
  ledger_index?: number;
  meta?: unknown;
  metaData?: unknown;
  tx_json?: Record<string, unknown> & { hash?: string; ledger_index?: number };
  transaction?: Record<string, unknown> & { hash?: string; ledger_index?: number };
  tx?: Record<string, unknown> & { hash?: string; ledger_index?: number };
}
