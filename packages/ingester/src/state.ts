import { decimalToScaled } from "@lending/shared";
import type { PrismaClient } from "@prisma/client";
import type { Client } from "xrpl";
import type { WatchedEnvironment } from "./subscriber.js";
import type { DecodedTransaction } from "./decode.js";

// Project the current vault/loan/broker/credential state for a setup, as derived from the captured
// stream. The event tells us which object changed; its authoritative current value is read from the
// validated ledger and stored as integer base units, so the derived "what is true now" matches the
// chain and never drifts off a recomputed float.
export async function projectState(
  db: PrismaClient,
  client: Client,
  env: WatchedEnvironment,
  tx: DecodedTransaction,
  owner: string,
): Promise<void> {
  switch (tx.txType) {
    case "VaultCreate":
    case "VaultDeposit":
    case "VaultWithdraw":
    case "LoanPay":
    case "LoanSet":
    case "LoanDelete":
      await projectVault(db, client, env, owner, tx.ledgerIndex);
      await projectBroker(db, client, env, owner, tx.ledgerIndex);
      await projectLoan(db, tx, tx.ledgerIndex, env);
      break;
    case "LoanBrokerSet":
    case "LoanBrokerCoverDeposit":
    case "LoanBrokerCoverWithdraw":
      await projectBroker(db, client, env, owner, tx.ledgerIndex);
      break;
    case "CredentialCreate":
    case "CredentialAccept":
    case "CredentialDelete":
      await projectCredential(db, env, tx);
      break;
    default:
      break;
  }
}

async function projectVault(db: PrismaClient, client: Client, env: WatchedEnvironment, owner: string, ledger: number): Promise<void> {
  const vault = await firstObject(client, owner, "vault");
  if (!vault) return;
  const scale = Number(vault.Scale ?? 0);
  const data = {
    vaultId: String(vault.index),
    assetsTotal: toBaseUnits(vault.AssetsTotal, scale),
    assetsAvailable: toBaseUnits(vault.AssetsAvailable, scale),
    lossUnrealized: toBaseUnits(vault.LossUnrealized, scale),
    shareOutstanding: await shareOutstanding(client, env.shareMptId),
    updatedLedger: ledger,
  };
  await db.vaultState.upsert({ where: { setupId: env.setupId }, create: { setupId: env.setupId, ...data }, update: data });
}

// Total vault shares in issue, read from the share MPT issuance (the vault object does not carry a
// share total). Shares are already integer base units on the issuance.
async function shareOutstanding(client: Client, shareMptId: string | undefined): Promise<bigint> {
  if (!shareMptId) return 0n;
  try {
    const res = await client.request({ command: "ledger_entry", mpt_issuance: shareMptId, ledger_index: "validated" });
    const node = res.result.node as unknown as Record<string, unknown> | undefined;
    return BigInt(String(node?.OutstandingAmount ?? "0"));
  } catch {
    return 0n;
  }
}

async function projectBroker(db: PrismaClient, client: Client, env: WatchedEnvironment, owner: string, ledger: number): Promise<void> {
  const broker = await firstObject(client, owner, "loan_broker");
  if (!broker) return;
  const data = {
    brokerId: String(broker.index),
    coverAvailable: toBaseUnits(broker.CoverAvailable, 6),
    debtTotal: toBaseUnits(broker.DebtTotal, 6),
    updatedLedger: ledger,
  };
  await db.brokerState.upsert({ where: { setupId: env.setupId }, create: { setupId: env.setupId, ...data }, update: data });
}

// Project loan state from the transaction's own metadata rather than from current ledger objects,
// because during a historical backfill the loan may already be gone — its created and deleted nodes
// are still present in each transaction's meta and give the correct point-in-time view.
async function projectLoan(db: PrismaClient, tx: DecodedTransaction, ledger: number, env: WatchedEnvironment): Promise<void> {
  const meta = (tx.raw as { meta?: unknown })?.meta;
  const affected = readAffectedNodes(meta);

  for (const node of affected) {
    if (node.entryType !== "Loan" || !node.loanId) continue;
    if (node.deleted) {
      await db.loanState.upsert({
        where: { setupId_loanId: { setupId: env.setupId, loanId: node.loanId } },
        create: { setupId: env.setupId, loanId: node.loanId, status: "closed", principalOutstanding: 0n, totalOutstanding: 0n, paymentRemaining: 0, updatedLedger: ledger },
        update: { status: "closed", principalOutstanding: 0n, totalOutstanding: 0n, paymentRemaining: 0, updatedLedger: ledger },
      });
      continue;
    }
    const fields = node.fields;
    const status = Number(fields.PaymentRemaining ?? 0) <= 0 ? "repaid" : "active";
    const data = {
      status,
      principalOutstanding: toBaseUnits(fields.PrincipalOutstanding, 6),
      totalOutstanding: toBaseUnits(fields.TotalValueOutstanding, 6),
      paymentRemaining: Number(fields.PaymentRemaining ?? 0),
      updatedLedger: ledger,
    };
    await db.loanState.upsert({
      where: { setupId_loanId: { setupId: env.setupId, loanId: node.loanId } },
      create: { setupId: env.setupId, loanId: node.loanId, ...data },
      update: data,
    });
  }
}

interface AffectedNode {
  entryType: string;
  loanId?: string;
  deleted: boolean;
  fields: Record<string, unknown>;
}

// Read the created/modified/deleted ledger nodes from transaction meta, normalized to the fields
// that describe a loan's current values.
function readAffectedNodes(meta: unknown): AffectedNode[] {
  const affected = (meta as { AffectedNodes?: unknown[] })?.AffectedNodes ?? [];
  const out: AffectedNode[] = [];
  for (const entry of affected) {
    const created = (entry as { CreatedNode?: RawNode }).CreatedNode;
    const modified = (entry as { ModifiedNode?: RawNode }).ModifiedNode;
    const deleted = (entry as { DeletedNode?: RawNode }).DeletedNode;
    const node = created ?? modified ?? deleted;
    if (!node) continue;
    out.push({
      entryType: node.LedgerEntryType ?? "",
      ...(node.LedgerIndex ? { loanId: node.LedgerIndex } : {}),
      deleted: Boolean(deleted),
      fields: node.NewFields ?? node.FinalFields ?? node.PreviousFields ?? {},
    });
  }
  return out;
}

interface RawNode {
  LedgerEntryType?: string;
  LedgerIndex?: string;
  NewFields?: Record<string, unknown>;
  FinalFields?: Record<string, unknown>;
  PreviousFields?: Record<string, unknown>;
}

async function projectCredential(db: PrismaClient, env: WatchedEnvironment, tx: DecodedTransaction): Promise<void> {
  const subject = String(tx.parsed.Subject ?? tx.parsed.Account ?? "");
  const credentialType = String(tx.parsed.CredentialType ?? "");
  if (!subject || !credentialType) return;
  const status = tx.txType === "CredentialDelete" ? "deleted" : tx.txType === "CredentialAccept" ? "accepted" : "issued";
  const data = { credentialType, status, updatedLedger: tx.ledgerIndex };
  await db.credentialState.upsert({
    where: { setupId_subject_credentialType: { setupId: env.setupId, subject, credentialType } },
    create: { setupId: env.setupId, subject, credentialType, status, updatedLedger: tx.ledgerIndex },
    update: data,
  });
}

async function firstObject(client: Client, account: string, type: "vault" | "loan_broker"): Promise<Record<string, unknown> | undefined> {
  const res = await client.request({ command: "account_objects", account, type, ledger_index: "validated" });
  const objs = res.result.account_objects as unknown as Record<string, unknown>[];
  return objs[0];
}

// Convert an on-ledger amount — a decimal string for an issued asset, or an Amount object — to
// integer base units at the given scale. A value carrying more precision than the scale is rounded
// down to the scale; a missing value is zero.
function toBaseUnits(value: unknown, scale: number): bigint {
  if (value === undefined || value === null) return 0n;
  const raw = typeof value === "string" ? value : typeof value === "object" && "value" in value ? String((value as { value: unknown }).value) : "0";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!match) return 0n;
  const whole = match[1] ?? "0";
  const frac = (match[2] ?? "").slice(0, scale).padEnd(scale, "0");
  try {
    return decimalToScaled(`${whole}.${frac}`, scale);
  } catch {
    return BigInt(whole) * 10n ** BigInt(scale);
  }
}
