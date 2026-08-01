import {
  Client,
  Wallet,
  BatchFlags,
  signMultiBatch,
  combineBatchSigners,
  decode,
  type Batch,
  type AccountObjectsRequest,
  type SubmittableTransaction,
  type TxResponse,
} from "xrpl";
import type { Network } from "./config/schema.js";
import { buildMemos } from "./memos.js";
import { withRetry } from "./retry.js";

const ENDPOINTS: Record<Network, string> = {
  devnet: "wss://s.devnet.rippletest.net:51233",
  "wasm-devnet": "wss://wasm.devnet.rippletest.net:51233",
};

export function endpointFor(network: Network): string {
  return ENDPOINTS[network];
}

export async function connect(network: Network): Promise<Client> {
  const client = new Client(endpointFor(network), { connectionTimeout: 20000 });
  await withRetry(() => client.connect(), {
    attempts: 4,
    retryable: (e) => /timeout|econn|socket|network|disconnect/i.test(String(e)),
  });
  return client;
}

export interface SubmitContext {
  setupId: string;
  correlationId: string;
}

export interface SubmitResult {
  hash: string;
  engineResult: string;
  validated: boolean;
  response: TxResponse;
}

// Stamp the setup and correlation ids onto a transaction, autofill, sign, submit, and wait for
// validation. Memos already present on the transaction are preserved; the tags are appended.
export async function submit(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  ctx: SubmitContext,
): Promise<SubmitResult> {
  const tagged = {
    ...tx,
    Memos: [...(("Memos" in tx && Array.isArray(tx.Memos) ? tx.Memos : [])), ...buildMemos(ctx.setupId, ctx.correlationId)],
  } as SubmittableTransaction;

  const prepared = await client.autofill(tagged);
  const signed = wallet.sign(prepared);
  const response = await client.submitAndWait(signed.tx_blob);
  const meta = response.result.meta;
  const engineResult =
    typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
  return {
    hash: response.result.hash,
    engineResult,
    validated: response.result.validated ?? false,
    response,
  };
}

// Submit a transaction that is expected to succeed; throw with the engine result if it does not.
export async function submitOrThrow(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
  ctx: SubmitContext,
): Promise<SubmitResult> {
  const result = await submit(client, wallet, tx, ctx);
  if (result.engineResult !== "tesSUCCESS") {
    throw new Error(`${tx.TransactionType} (${ctx.correlationId}) returned ${result.engineResult}`);
  }
  return result;
}

// Classify an engine result for batch retry handling. Provisioning transactions are expected to
// succeed, so anything permanent is fatal; only genuinely transient results are retried.
export function classifyResult(engineResult: string): "ok" | "retry" | "fatal" {
  if (engineResult === "tesSUCCESS") return "ok";
  // Transient: queued behind another tx, sequence not yet current, fee risen, or open-ledger
  // per-account queue overflow (tel* codes) — all resolve once the ledger drains or advances.
  if ([
    "terQUEUED", "terPRE_SEQ", "tefPAST_SEQ", "tecINSUFFICIENT_FEE",
    "telCAN_NOT_QUEUE", "telCAN_NOT_QUEUE_ANY", "telCAN_NOT_QUEUE_FULL",
    "telCAN_NOT_QUEUE_BLENDED", "telCAN_NOT_QUEUE_BLOCKED",
  ].includes(engineResult)) return "retry";
  // Everything else — tem* (malformed), other tef*, other tec* — is permanent for a provisioning tx.
  return "fatal";
}

export interface BatchItem {
  wallet: Wallet;
  tx: SubmittableTransaction;
  ctx: SubmitContext;
}

// Submit many transactions across the minimum number of ledgers. Transactions are grouped by signing
// account; each account's sequence is fetched once and assigned locally (N, N+1, …) so all of an
// account's transactions enter one ledger. Everything is submitted without waiting, then every hash is
// polled in parallel. Retryable results (queue/sequence/fee) are retried with backoff; a permanent
// failure fails the whole batch, because every provisioning transaction is expected to succeed.
// Results are returned in input order.
// The XRPL open-ledger per-account queue is ~10; stay under it with headroom.
const MAX_PER_ACCOUNT_PER_LEDGER = 8;

export async function submitBatch(client: Client, items: BatchItem[]): Promise<SubmitResult[]> {
  if (items.length === 0) return [];
  const results = new Array<SubmitResult | undefined>(items.length);
  const MAX_ATTEMPTS = 4;

  // Indices still needing a result, grouped fresh each attempt (a retry re-fetches sequences).
  let pending = items.map((_, i) => i);
  for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length > 0; attempt++) {
    const currentLedger = ((await client.request({ command: "ledger_current" })).result as { ledger_current_index: number }).ledger_current_index;

    // Group pending indices by signing account.
    const byAccount = new Map<string, number[]>();
    for (const i of pending) {
      const addr = items[i]!.wallet.address;
      (byAccount.get(addr) ?? byAccount.set(addr, []).get(addr)!).push(i);
    }

    // Assign sequences per account and sign. Cap at MAX_PER_ACCOUNT_PER_LEDGER per account per
    // attempt; any overflow is carried into the next attempt (not an error — no penalty).
    const prepared: { index: number; blob: string; hash: string }[] = [];
    const carriedOver: number[] = [];
    for (const [addr, indices] of byAccount) {
      const info = await client.request({ command: "account_info", account: addr, ledger_index: "current" });
      let seq = Number(info.result.account_data.Sequence);
      const thisLedger = indices.slice(0, MAX_PER_ACCOUNT_PER_LEDGER);
      const overflow = indices.slice(MAX_PER_ACCOUNT_PER_LEDGER);
      carriedOver.push(...overflow);
      for (const i of thisLedger) {
        const { wallet, tx, ctx } = items[i]!;
        const tagged = {
          ...tx,
          Memos: [...(("Memos" in tx && Array.isArray(tx.Memos) ? tx.Memos : [])), ...buildMemos(ctx.setupId, ctx.correlationId)],
        } as SubmittableTransaction;
        const filled = await client.autofill(tagged);
        filled.Sequence = seq++; // intentionally overrides autofill — client-managed sequence is the whole point of batching
        filled.LastLedgerSequence = currentLedger + 40; // intentionally overrides autofill — pin all batch txns to the same ledger window
        const signed = wallet.sign(filled);
        prepared.push({ index: i, blob: signed.tx_blob, hash: signed.hash });
      }
    }

    // Submit all without waiting; classify preliminary results.
    const toPoll: { index: number; hash: string }[] = [];
    // Seed retry with carried-over indices (overflow from the per-account cap — not errors).
    const retry: number[] = [...carriedOver];
    for (const p of prepared) {
      const res = await client.request({ command: "submit", tx_blob: p.blob });
      const prelim = (res.result as { engine_result: string }).engine_result;
      const bucket = classifyResult(prelim);
      if (bucket === "fatal") {
        throw new Error(`${items[p.index]!.tx.TransactionType} (${items[p.index]!.ctx.correlationId}) submit returned ${prelim}`);
      }
      if (bucket === "retry") retry.push(p.index);
      else toPoll.push({ index: p.index, hash: p.hash });
    }

    // Poll accepted hashes in parallel for validation.
    await Promise.all(toPoll.map(async ({ index, hash }) => {
      const validated = await pollValidated(client, hash, currentLedger + 40);
      if (!validated) { retry.push(index); return; }
      const bucket = classifyResult(validated.engineResult);
      if (bucket === "fatal") {
        throw new Error(`${items[index]!.tx.TransactionType} (${items[index]!.ctx.correlationId}) returned ${validated.engineResult}`);
      }
      if (bucket === "retry") retry.push(index);
      else results[index] = validated;
    }));

    pending = retry;
    if (pending.length > 0) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }

  if (pending.length > 0) {
    const stuck = pending.map((i) => items[i]!.ctx.correlationId).join(", ");
    throw new Error(`submitBatch: ${pending.length} transactions never validated after ${MAX_ATTEMPTS} attempts: ${stuck}`);
  }
  return results as SubmitResult[];
}

export interface BatchInner {
  wallet: Wallet;
  tx: SubmittableTransaction;
  ctx: SubmitContext;
}

// Submit 2–8 transactions as ONE atomic XLS-56 Batch (tfAllOrNothing): either every inner applies or
// none does. Unlike submitBatch (which co-locates each account's own txns per ledger but keeps them
// independent), this is a hard, cross-account atomic unit — used for pairs that must succeed together
// (credential create+accept; trust+distribute). Inner sequences and fees are filled by autofill;
// tfInnerBatchTxn is set here. Each distinct account signs its own copy (signMultiBatch mutates in
// place, so a copy per account), the copies are merged with combineBatchSigners, and the submitting
// account signs the outer. Retries a transient outer result; a permanent result throws.
const TF_INNER_BATCH_TXN = 0x40000000;

export async function submitNativeBatch(client: Client, inners: BatchInner[]): Promise<SubmitResult> {
  if (inners.length < 2 || inners.length > 8) {
    throw new Error(`submitNativeBatch: needs 2–8 inner transactions, got ${inners.length}`);
  }

  // The network base fee, read once — it rarely moves ledger-to-ledger and is only used to top up the
  // outer fee below, so there is no need to re-fetch it per retry.
  const baseFeeDrops = BigInt((await client.request({ command: "fee" })).result.drops.base_fee);

  const MAX_ATTEMPTS = 4;
  let lastResult = "unknown";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Tag each inner and mark it as an inner-batch txn. Do NOT set Sequence/Fee/SigningPubKey — autofill
    // fills them and rejects non-conforming presets. No LastLedgerSequence on inners (batch rejects it).
    const rawTransactions = inners.map(({ tx, ctx }) => {
      const existingFlags = typeof (tx as { Flags?: number }).Flags === "number" ? (tx as { Flags: number }).Flags : 0;
      const inner = {
        ...tx,
        Flags: existingFlags | TF_INNER_BATCH_TXN,
        Memos: [...(("Memos" in tx && Array.isArray(tx.Memos) ? tx.Memos : [])), ...buildMemos(ctx.setupId, ctx.correlationId)],
      } as SubmittableTransaction;
      return { RawTransaction: inner };
    });

    // The submitting account: the first inner's account. It signs the outer too.
    const submitter = inners[0]!.wallet;
    const batch: Batch = {
      TransactionType: "Batch",
      Account: submitter.address,
      Flags: BatchFlags.tfAllOrNothing,
      RawTransactions: rawTransactions,
    };

    const autofilled = await client.autofill(batch as unknown as SubmittableTransaction) as unknown as Batch;

    // Each distinct account signs a SEPARATE copy (signMultiBatch overwrites BatchSigners in place).
    const accounts = new Map<string, Wallet>();
    for (const { wallet } of inners) accounts.set(wallet.address, wallet);

    // Fee: autofill computes the Batch base (2×base + Σ inner fees) but does not count BatchSigners, so
    // add one base fee per BatchSigner or the ledger returns telINSUF_FEE_P. combineBatchSigners drops
    // the submitter's own BatchSigner (the submitter signs the outer directly), so the count is the
    // distinct accounts MINUS the submitter — always accounts.size - 1, since the submitter is one of them.
    autofilled.Fee = (BigInt(autofilled.Fee ?? "0") + baseFeeDrops * BigInt(accounts.size - 1)).toString();
    const signedCopies = [...accounts.values()].map((wallet) => {
      const copy = structuredClone(autofilled);
      signMultiBatch(wallet, copy, { batchAccount: wallet.address });
      return copy;
    });

    // Merge all BatchSigners into one (still-unsigned-outer) blob, then the submitter signs the outer.
    const combinedBlob = combineBatchSigners(signedCopies);
    const combined = decode(combinedBlob) as unknown as SubmittableTransaction;
    const signed = submitter.sign(combined);
    const response = await client.submitAndWait(signed.tx_blob);
    const meta = response.result.meta;
    const engineResult = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
    lastResult = engineResult;

    const bucket = classifyResult(engineResult);
    if (bucket === "ok") {
      return { hash: response.result.hash, engineResult, validated: response.result.validated ?? false, response };
    }
    if (bucket === "fatal") {
      const corr = inners.map((i) => i.ctx.correlationId).join(", ");
      throw new Error(`Batch (${corr}) returned ${engineResult}`);
    }
    // retry: brief backoff, rebuild (fresh sequences) and resubmit.
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }

  const corr = inners.map((i) => i.ctx.correlationId).join(", ");
  throw new Error(`submitNativeBatch: Batch (${corr}) never validated after ${MAX_ATTEMPTS} attempts (last: ${lastResult})`);
}

// Poll a transaction hash until it is validated or its LastLedgerSequence passes. Returns the validated
// result, or undefined if the ledger advanced past the tx's window without validating it (retryable).
async function pollValidated(client: Client, hash: string, lastLedger: number): Promise<SubmitResult | undefined> {
  for (;;) {
    try {
      const res = await client.request({ command: "tx", transaction: hash });
      if (res.result.validated) {
        const meta = res.result.meta;
        const engineResult = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
        return { hash, engineResult, validated: true, response: res as unknown as TxResponse };
      }
    } catch {
      // txnNotFound while the tx is still propagating — keep polling until the ledger window closes.
    }
    const current = ((await client.request({ command: "ledger_current" })).result as { ledger_current_index: number }).ledger_current_index;
    if (current > lastLedger) return undefined;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

type AccountObjectType = NonNullable<AccountObjectsRequest["type"]>;

// Fetch an account's objects of a given type from the validated ledger.
export async function accountObjects(
  client: Client,
  account: string,
  type?: AccountObjectType,
): Promise<Record<string, unknown>[]> {
  const request: AccountObjectsRequest = {
    command: "account_objects",
    account,
    ledger_index: "validated",
    ...(type ? { type } : {}),
  };
  const res = await client.request(request);
  return res.result.account_objects as unknown as Record<string, unknown>[];
}
