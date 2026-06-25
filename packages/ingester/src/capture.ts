import type { PrismaClient } from "@prisma/client";
import type { DecodedTransaction } from "./decode.js";

export interface CaptureResult {
  txHash: string;
  inserted: boolean;
}

// Capture one transaction into the store, at least once and idempotently.
//
// The transaction row and its outbox marker are written in a single database transaction, so a
// crash never leaves a captured transaction without its outbox marker. The tx hash is the primary
// key, so re-seeing a transaction — on replay or restart — is a no-op rather than a double-count.
export async function captureTransaction(
  db: PrismaClient,
  networkId: string,
  tx: DecodedTransaction,
): Promise<CaptureResult> {
  // Only transactions belonging to a known setup are stored; an untagged transaction on a watched
  // account is not part of a provisioned run.
  if (!tx.setupId) return { txHash: tx.txHash, inserted: false };

  const existing = await db.transaction.findUnique({ where: { txHash: tx.txHash }, select: { txHash: true } });
  if (existing) return { txHash: tx.txHash, inserted: false };

  await db.$transaction([
    db.transaction.create({
      data: {
        txHash: tx.txHash,
        setupId: tx.setupId,
        networkId,
        ledgerIndex: tx.ledgerIndex,
        txType: tx.txType,
        raw: tx.raw as object,
        parsed: tx.parsed as object,
      },
    }),
    db.outbox.create({
      data: { id: tx.txHash, txHash: tx.txHash, setupId: tx.setupId },
    }),
  ]);

  return { txHash: tx.txHash, inserted: true };
}

// Advance the per-setup ingestion cursor to the highest ledger index captured, so a restart
// resumes from here without re-reading earlier ledgers.
export async function advanceCursor(db: PrismaClient, setupId: string, ledgerIndex: number): Promise<void> {
  await db.ingestCursor.upsert({
    where: { setupId },
    create: { setupId, lastLedgerIndex: ledgerIndex },
    update: { lastLedgerIndex: { set: ledgerIndex } },
  });
}

export async function lastLedgerIndex(db: PrismaClient, setupId: string): Promise<number | undefined> {
  const cursor = await db.ingestCursor.findUnique({ where: { setupId } });
  return cursor?.lastLedgerIndex;
}
