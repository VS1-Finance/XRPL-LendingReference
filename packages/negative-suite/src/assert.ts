import type { Client, SubmittableTransaction, Wallet } from "xrpl";
import { buildMemos } from "@lending/shared";
import type { CaseContext, Expectation, Observed } from "./types.js";

// Submit an action that is expected to be rejected, and capture the engine result — whether the
// rejection comes back from the validated ledger (a tec/tem/tef code in the metadata) or is thrown
// client-side at preflight (an ill-formed or malformed-signer transaction never reaches consensus).
// Either way the observed code is returned rather than throwing, so the case can compare it.
export async function submitExpectReject(
  ctx: CaseContext,
  wallet: Wallet,
  tx: SubmittableTransaction,
  correlationId: string,
): Promise<Observed> {
  const tagged = {
    ...tx,
    Memos: [...(("Memos" in tx && Array.isArray(tx.Memos) ? tx.Memos : [])), ...buildMemos(ctx.env.setupId, correlationId)],
  } as SubmittableTransaction;

  try {
    const prepared = await ctx.client.autofill(tagged);
    const res = await ctx.client.submitAndWait(wallet.sign(prepared).tx_blob);
    const meta = res.result.meta;
    const code = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
    return { code, txHash: res.result.hash };
  } catch (err) {
    return { code: extractCode(err), detail: "preflight/submit rejection" };
  }
}

// Submit an action that is expected to succeed (used by correctness cases), returning its result.
export async function submitExpectSuccess(
  ctx: CaseContext,
  wallet: Wallet,
  tx: SubmittableTransaction,
  correlationId: string,
): Promise<Observed> {
  const tagged = {
    ...tx,
    Memos: [...(("Memos" in tx && Array.isArray(tx.Memos) ? tx.Memos : [])), ...buildMemos(ctx.env.setupId, correlationId)],
  } as SubmittableTransaction;
  const prepared = await ctx.client.autofill(tagged);
  const res = await ctx.client.submitAndWait(wallet.sign(prepared).tx_blob);
  const meta = res.result.meta;
  const code = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
  return { code, txHash: res.result.hash };
}

// Decide whether an observed outcome satisfies a case's expectation.
export function evaluate(expected: Expectation, observed: Observed): boolean {
  switch (expected.kind) {
    case "reject":
      return matchesCode(observed.code, expected.code);
    case "reject-any":
      return expected.codes.some((c) => matchesCode(observed.code, c));
    case "success":
      return observed.code === "tesSUCCESS";
    case "deferred":
      return true; // reported, not asserted
  }
}

// A rejection code matches if the observed code equals it, or (for client-side throws that carry a
// longer message) contains it — e.g. an observed "temBAD_SIGNER: ..." matches an expected
// "temBAD_SIGNER".
function matchesCode(observed: string, expected: string): boolean {
  return observed === expected || observed.includes(expected);
}

function extractCode(err: unknown): string {
  const data = (err as { data?: { engine_result?: string; error?: string; error_message?: string } })?.data;
  if (data?.engine_result) return data.engine_result;
  if (data?.error) return data.error;
  if (err instanceof Error) return err.message;
  return String(err);
}
