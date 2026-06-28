import type { Client } from "xrpl";
import type { Session } from "../session.js";

// Small validated-ledger reads used by bot variants to decide whether to act. Kept here so the
// variants stay strategy-only.

export async function shareBalance(client: Client, holder: string, shareMptId: string): Promise<bigint> {
  const res = await client.request({ command: "account_objects", account: holder, type: "mptoken", ledger_index: "validated" });
  const objs = res.result.account_objects as unknown as Record<string, unknown>[];
  const share = objs.find((o) => o.MPTokenIssuanceID === shareMptId);
  return BigInt((share?.MPTAmount as string | undefined) ?? "0");
}

export async function ownerLoanId(session: Session, borrower: string): Promise<string | undefined> {
  for (const account of [session.env.accounts.owner.address, borrower]) {
    const res = await session.client.request({ command: "account_objects", account, type: "loan", ledger_index: "validated" });
    const objs = res.result.account_objects as unknown as Record<string, unknown>[];
    if (objs[0]?.index) return objs[0].index as string;
  }
  return undefined;
}

export async function loanNode(client: Client, loanId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await client.request({ command: "ledger_entry", index: loanId, ledger_index: "validated" });
    return res.result.node as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function iouAmount(session: Session, value: string): { currency: string; issuer: string; value: string } {
  const { currency, issuer } = session.env.asset;
  if (!issuer) throw new Error("session asset has no issuer");
  return { currency, issuer, value };
}
