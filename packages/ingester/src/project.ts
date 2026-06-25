import type { PrismaClient } from "@prisma/client";
import type { DecodedTransaction } from "./decode.js";
import type { WatchedEnvironment } from "./subscriber.js";

// Map a transaction type to the normalized event type the store records.
const EVENT_TYPE: Record<string, string> = {
  VaultDeposit: "deposit",
  VaultWithdraw: "withdrawal",
  LoanSet: "origination",
  LoanPay: "payment",
  LoanDelete: "loan_closed",
  LoanManage: "loan_managed",
  LoanBrokerCoverDeposit: "cover_deposit",
  LoanBrokerCoverWithdraw: "cover_withdrawal",
  LoanBrokerSet: "broker_set",
  VaultCreate: "vault_created",
  CredentialCreate: "credential_issued",
  CredentialAccept: "credential_accepted",
  CredentialDelete: "credential_deleted",
  PermissionedDomainSet: "domain_set",
};

// Normalize a captured transaction into a typed event row, ordered within its setup by ledger index
// and a monotonic sequence. The event carries the correlation id so a run's actions can be replayed
// in order.
export async function projectEvent(db: PrismaClient, env: WatchedEnvironment, tx: DecodedTransaction): Promise<void> {
  const type = EVENT_TYPE[tx.txType] ?? "other";
  const seq = await nextSeq(db, env.setupId);

  await db.event.create({
    data: {
      id: tx.txHash,
      txHash: tx.txHash,
      setupId: env.setupId,
      correlationId: tx.correlationId ?? null,
      type,
      ledgerIndex: tx.ledgerIndex,
      seq,
      payload: tx.parsed as object,
    },
  });
}

// The next per-setup event sequence number. Events are ordered by ledger index then capture order;
// the sequence gives a stable total order even when several land in the same ledger.
async function nextSeq(db: PrismaClient, setupId: string): Promise<number> {
  const last = await db.event.findFirst({ where: { setupId }, orderBy: { seq: "desc" }, select: { seq: true } });
  return (last?.seq ?? 0) + 1;
}
