import {
  Client,
  Wallet,
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
