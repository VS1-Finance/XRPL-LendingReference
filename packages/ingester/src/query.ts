import type { PrismaClient } from "@prisma/client";

// Read APIs over the history store. These reassemble a run's ordered actions and report the current
// derived state, keyed by setup id and correlation id.

export interface ActionRow {
  seq: number;
  type: string;
  correlationId: string | null;
  txHash: string;
  ledgerIndex: number;
}

// A run's actions in order. Optionally narrowed to a single correlation id.
export async function actionsForSetup(db: PrismaClient, setupId: string, correlationId?: string): Promise<ActionRow[]> {
  const events = await db.event.findMany({
    where: { setupId, ...(correlationId ? { correlationId } : {}) },
    orderBy: [{ ledgerIndex: "asc" }, { seq: "asc" }],
    select: { seq: true, type: true, correlationId: true, txHash: true, ledgerIndex: true },
  });
  return events;
}

export interface CurrentState {
  vault?: Record<string, string | number>;
  broker?: Record<string, string | number>;
  loans: Record<string, string | number>[];
  credentials: Record<string, string | number>[];
}

// The current derived state for a setup. BigInt columns are rendered as strings so the result is
// plain JSON.
export async function stateForSetup(db: PrismaClient, setupId: string): Promise<CurrentState> {
  const [vault, broker, loans, credentials] = await Promise.all([
    db.vaultState.findUnique({ where: { setupId } }),
    db.brokerState.findUnique({ where: { setupId } }),
    db.loanState.findMany({ where: { setupId } }),
    db.credentialState.findMany({ where: { setupId } }),
  ]);

  return {
    ...(vault ? { vault: stringifyBigInts(vault) } : {}),
    ...(broker ? { broker: stringifyBigInts(broker) } : {}),
    loans: loans.map(stringifyBigInts),
    credentials: credentials.map(stringifyBigInts),
  };
}

export async function transactionCount(db: PrismaClient, setupId: string): Promise<number> {
  return db.transaction.count({ where: { setupId } });
}

function stringifyBigInts(row: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "number") out[k] = v;
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (v !== null && v !== undefined) out[k] = String(v);
  }
  return out;
}
