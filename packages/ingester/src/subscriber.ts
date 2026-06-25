import { connect } from "@lending/shared";
import type { Client } from "xrpl";
import type { PrismaClient } from "@prisma/client";
import { advanceCursor, captureTransaction, lastLedgerIndex } from "./capture.js";
import { decodeTransaction, type TxStreamLike } from "./decode.js";
import { projectEvent } from "./project.js";

export interface WatchedEnvironment {
  setupId: string;
  network: "devnet" | "wasm-devnet";
  networkId: string;
  accounts: string[];
}

export interface SubscriberOptions {
  fromLedger?: number;
  // When set, the subscriber backfills and returns instead of holding the live stream open. Used by
  // tests and one-shot captures.
  once?: boolean;
  log?: (msg: string) => void;
}

// Subscribe to the ledger's transaction stream filtered to a setup's accounts, and capture every
// tagged transaction into the store. On start the gap since the last persisted ledger is backfilled
// from account history, then the live stream is followed — so a restart resumes without gaps or
// double-counts (capture is idempotent on tx hash).
export async function runSubscriber(db: PrismaClient, env: WatchedEnvironment, options: SubscriberOptions = {}): Promise<void> {
  const log = options.log ?? (() => {});
  const client = await connect(env.network);
  try {
    const resumeFrom = options.fromLedger ?? ((await lastLedgerIndex(db, env.setupId)) ?? 0) + 1;
    log(`backfilling ${env.setupId} from ledger ${resumeFrom}`);
    await backfill(client, db, env, resumeFrom, log);

    if (options.once) return;

    await client.request({ command: "subscribe", accounts: env.accounts });
    log(`watching ${env.accounts.length} accounts on ${env.network}`);

    await new Promise<void>((resolve) => {
      client.on("transaction", (msg) => {
        void handle(db, env, msg as unknown as TxStreamLike, log);
      });
      client.on("disconnected", () => resolve());
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
  } finally {
    await client.disconnect();
  }
}

// Walk an account's history forward from a ledger index and capture every tagged transaction. Each
// watched account is queried; idempotent capture dedupes transactions touching more than one of
// them.
async function backfill(client: Client, db: PrismaClient, env: WatchedEnvironment, fromLedger: number, log: (m: string) => void): Promise<void> {
  for (const account of env.accounts) {
    let marker: unknown = undefined;
    do {
      const res = await client.request({
        command: "account_tx",
        account,
        ledger_index_min: fromLedger,
        ledger_index_max: -1,
        forward: true,
        limit: 200,
        ...(marker ? { marker } : {}),
      });
      for (const entry of res.result.transactions as unknown as TxStreamLike[]) {
        await handle(db, env, entry, log);
      }
      marker = res.result.marker;
    } while (marker);
  }
}

async function handle(db: PrismaClient, env: WatchedEnvironment, entry: TxStreamLike, log: (m: string) => void): Promise<void> {
  const decoded = decodeTransaction(entry);
  if (!decoded || decoded.setupId !== env.setupId) return;

  const result = await captureTransaction(db, env.networkId, decoded);
  if (result.inserted) {
    await projectEvent(db, env, decoded);
    await advanceCursor(db, env.setupId, decoded.ledgerIndex);
    log(`captured ${decoded.txType} ${decoded.txHash.slice(0, 12)}… (ledger ${decoded.ledgerIndex})`);
  }
}
