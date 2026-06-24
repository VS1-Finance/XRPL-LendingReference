import { clampIssuedValueUp } from "@lending/shared";
import type { Client } from "xrpl";
import type { ProvisionedEnvironment } from "./types.js";

// Build the Amount object for the environment's asset at a given value. For an issued asset the
// value is clamped to the ledger's 15-significant-digit limit (rounded up so a derived repayment
// never lands a sub-unit short); for XRP the value is passed through as drops.
export function assetAmount(env: ProvisionedEnvironment, value: string): string | { currency: string; issuer: string; value: string } {
  if (env.asset.currency === "XRP") return value;
  if (!env.asset.issuer) throw new Error("issued asset is missing its issuer in the provisioned graph");
  return { currency: env.asset.currency, issuer: env.asset.issuer, value: clampIssuedValueUp(value) };
}

// The depositor's current share balance, read from the share MPT issued by the vault.
export async function shareBalance(client: Client, holder: string, shareMptId: string): Promise<string> {
  const res = await client.request({ command: "account_objects", account: holder, type: "mptoken", ledger_index: "validated" });
  const objs = res.result.account_objects as unknown as Record<string, unknown>[];
  const share = objs.find((o) => o.MPTokenIssuanceID === shareMptId);
  return (share?.MPTAmount as string | undefined) ?? "0";
}

// The holder's balance of the environment's issued asset, as a decimal string.
export async function issuedAssetBalance(client: Client, holder: string, env: ProvisionedEnvironment): Promise<string> {
  if (env.asset.currency === "XRP" || !env.asset.issuer) return "0";
  const res = await client.request({ command: "account_lines", account: holder, peer: env.asset.issuer, ledger_index: "validated" });
  const line = res.result.lines.find((l) => l.currency === env.asset.currency);
  return line?.balance ?? "0";
}

// Read a loan object by id from the validated ledger, or undefined if it no longer exists (a fully
// repaid loan is removed from the ledger).
export async function readLoan(client: Client, loanId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await client.request({ command: "ledger_entry", index: loanId, ledger_index: "validated" });
    return res.result.node as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// Find the loan most recently created under either the owner (broker) or the borrower.
export async function findLoanId(client: Client, owner: string, borrower: string): Promise<string | undefined> {
  for (const account of [owner, borrower]) {
    const res = await client.request({ command: "account_objects", account, type: "loan", ledger_index: "validated" });
    const objs = res.result.account_objects as unknown as Record<string, unknown>[];
    if (objs[0]?.index) return objs[0].index as string;
  }
  return undefined;
}
