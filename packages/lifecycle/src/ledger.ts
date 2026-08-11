import { clampIssuedValueUp, decimalToScaled, dropsToXrpString, scaledToDecimal } from "@lending/shared";
import { xrpToDrops, type Amount, type Client, type MPTAmount } from "xrpl";
import type { ProvisionedEnvironment } from "./types.js";

// The scale the environment's vault-asset MPT issuance was actually created at, read back from env (not
// a const — an environment could have been provisioned at any scale). The lifecycle runner reasons in
// whole-token units and needs this scale to shape/read a raw integer MPT amount.
function mptAssetScale(env: ProvisionedEnvironment): number {
  return env.objects.assetScale ?? 2;
}

// Whether the environment's asset is native XRP rather than an issued token.
function isXrp(env: ProvisionedEnvironment): boolean {
  return env.asset.currency === "XRP" && !env.asset.issuer;
}

// Whether the environment's asset is an MPT vault asset (currency "MPT", identified by
// env.objects.assetMptId rather than a currency/issuer pair).
function isMpt(env: ProvisionedEnvironment): boolean {
  return env.asset.currency === "MPT";
}

// Build the Amount for the environment's asset from a whole-token value. For XRP that is a bare drops
// string; for MPT it is an mpt_issuance_id/value object with the value scaled to the issuance's raw
// integer units; for an issued asset it is a currency/issuer/value object with the value clamped to the
// ledger's 15-significant-digit limit (rounded up so a derived repayment never lands a sub-unit short).
export function assetAmount(env: ProvisionedEnvironment, value: string): Amount | MPTAmount {
  if (isXrp(env)) return xrpToDrops(value);
  if (isMpt(env)) {
    const mptIssuanceId = env.objects.assetMptId;
    if (!mptIssuanceId) throw new Error("MPT asset is missing its assetMptId in the provisioned graph");
    return { mpt_issuance_id: mptIssuanceId, value: decimalToScaled(value, mptAssetScale(env)).toString() };
  }
  if (!env.asset.issuer) throw new Error("issued asset is missing its issuer in the provisioned graph");
  return { currency: env.asset.currency, issuer: env.asset.issuer, value: clampIssuedValueUp(value) };
}

// Converts an amount read off the ledger (drops for XRP, a raw integer at the environment's actual
// assetScale for MPT, a decimal token value for IOU) into the whole-token units assetAmount expects.
// Loan balances come back in ledger units, so a repayment derived from a loan's outstanding balance
// passes through here first.
export function ledgerToWhole(env: ProvisionedEnvironment, value: string): string {
  if (isXrp(env)) return dropsToXrpString(value);
  if (isMpt(env)) return scaledToDecimal(BigInt(value), mptAssetScale(env));
  return value;
}

// A whole-token value in the broker's asset units as a bare string, for scalar fields like the loan
// principal that take a plain number rather than a full Amount: drops for XRP, the issuance's raw
// integer units for MPT, whole tokens otherwise.
export function brokerValue(env: ProvisionedEnvironment, value: string): string {
  if (isXrp(env)) return xrpToDrops(value);
  if (isMpt(env)) return decimalToScaled(value, mptAssetScale(env)).toString();
  return value;
}

// The depositor's current share balance, read from the share MPT issued by the vault.
export async function shareBalance(client: Client, holder: string, shareMptId: string): Promise<string> {
  const res = await client.request({ command: "account_objects", account: holder, type: "mptoken", ledger_index: "validated" });
  const objs = res.result.account_objects as unknown as Record<string, unknown>[];
  const share = objs.find((o) => o.MPTokenIssuanceID === shareMptId);
  return (share?.MPTAmount as string | undefined) ?? "0";
}

// The holder's balance of the environment's issued asset, as a decimal string. For MPT, the raw
// on-ledger integer balance is scaled down to whole tokens so it is directly comparable to the
// whole-token values assetAmount/brokerValue take (matching the IOU branch's convention).
export async function issuedAssetBalance(client: Client, holder: string, env: ProvisionedEnvironment): Promise<string> {
  if (env.asset.currency === "XRP") return "0";
  if (isMpt(env)) {
    const mptIssuanceId = env.objects.assetMptId;
    if (!mptIssuanceId) return "0";
    const res = await client.request({ command: "account_objects", account: holder, type: "mptoken", ledger_index: "validated" });
    const objs = res.result.account_objects as unknown as Record<string, unknown>[];
    const held = objs.find((o) => o.MPTokenIssuanceID === mptIssuanceId);
    const raw = (held?.MPTAmount as string | undefined) ?? "0";
    return scaledToDecimal(BigInt(raw), mptAssetScale(env));
  }
  if (!env.asset.issuer) return "0";
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
