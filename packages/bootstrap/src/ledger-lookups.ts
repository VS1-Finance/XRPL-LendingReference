import { accountObjects } from "@lending/shared";
import type { Client } from "xrpl";

// Lookups used to make each provisioning step idempotent: before submitting, the harness checks
// whether the object it would create already exists, and skips the transaction if so.

// A credential type is given as readable ASCII in config and hex-encoded for the ledger.
export function encodeCredentialType(type: string): string {
  return Buffer.from(type, "utf8").toString("hex").toUpperCase();
}

export async function findDomainId(client: Client, owner: string): Promise<string | undefined> {
  const objs = await accountObjects(client, owner, "permissioned_domain");
  return objs[0]?.index as string | undefined;
}

export async function findVault(client: Client, owner: string): Promise<{ index: string; shareMptId?: string; vaultKind?: number } | undefined> {
  const objs = await accountObjects(client, owner, "vault");
  const vault = objs[0];
  if (!vault) return undefined;
  return { index: vault.index as string, shareMptId: vault.ShareMPTID as string | undefined, vaultKind: vault.VaultKind as number | undefined };
}

export async function findBrokerId(client: Client, owner: string): Promise<string | undefined> {
  const objs = await accountObjects(client, owner, "loan_broker");
  return objs[0]?.index as string | undefined;
}

// Current first-loss cover held by the owner's broker, as a decimal string in asset units.
// Returns undefined when no broker exists. The field is named CoverAvailable on the object.
export async function findBrokerCover(client: Client, owner: string): Promise<string | undefined> {
  const objs = await accountObjects(client, owner, "loan_broker");
  const broker = objs[0];
  if (!broker) return undefined;
  const cover = broker.CoverAvailable;
  if (typeof cover === "string") return cover;
  if (cover && typeof cover === "object" && "value" in cover) return String((cover as { value: unknown }).value);
  return "0";
}

// Whether a subject already holds an accepted credential of a given type from a given issuer.
export async function hasAcceptedCredential(
  client: Client,
  subject: string,
  issuer: string,
  credentialTypeHex: string,
): Promise<boolean> {
  const objs = await accountObjects(client, subject, "credential");
  return objs.some(
    (c) =>
      c.Issuer === issuer &&
      c.Subject === subject &&
      c.CredentialType === credentialTypeHex &&
      // An accepted credential clears the lsfAccepted flag check; an unaccepted one is still
      // pending. Treat a present, accepted credential as already provisioned.
      isAccepted(c),
  );
}

function isAccepted(credential: Record<string, unknown>): boolean {
  const flags = typeof credential.Flags === "number" ? credential.Flags : 0;
  const LSF_ACCEPTED = 0x00010000;
  return (flags & LSF_ACCEPTED) !== 0;
}

// Whether a holder already has a trust line for a currency to an issuer.
export async function hasTrustLine(
  client: Client,
  holder: string,
  currency: string,
  issuer: string,
): Promise<boolean> {
  const res = await client.request({
    command: "account_lines",
    account: holder,
    peer: issuer,
    ledger_index: "validated",
  });
  return res.result.lines.some((line) => line.currency === currency);
}

// A holder's balance of a currency from an issuer, as a decimal string ("0" if no line exists).
export async function issuedBalance(
  client: Client,
  holder: string,
  currency: string,
  issuer: string,
): Promise<string> {
  const res = await client.request({
    command: "account_lines",
    account: holder,
    peer: issuer,
    ledger_index: "validated",
  });
  const line = res.result.lines.find((l) => l.currency === currency);
  return line?.balance ?? "0";
}

// The issuer's own mpt_issuance object, if one already exists — used to make MPTokenIssuanceCreate
// idempotent on re-run, and to read back the MPTokenIssuanceID once created.
export async function findMptIssuance(client: Client, issuer: string): Promise<{ id: string } | undefined> {
  const objs = await accountObjects(client, issuer, "mpt_issuance");
  const issuance = objs[0];
  if (!issuance) return undefined;
  // Use `mpt_issuance_id` (the 192-bit MPTokenIssuanceID, 48 hex chars) — NOT `index`, which is the
  // 256-bit ledger object key (64 hex). MPTokenIssuanceID / VaultCreate.Asset expect the Hash192; the
  // ledger index would fail serialization with "Invalid Hash length 32".
  return { id: issuance.mpt_issuance_id as string };
}

// A holder's balance of a given MPT issuance, as a decimal string ("0" if unauthorized or holding
// none). Mirrors issuedBalance for the IOU path.
export async function mptBalance(client: Client, holder: string, mptIssuanceId: string): Promise<string> {
  const objs = await accountObjects(client, holder, "mptoken");
  const token = objs.find((o) => o.MPTokenIssuanceID === mptIssuanceId);
  return (token?.MPTAmount as string | undefined) ?? "0";
}

// Whether a holder has already opted in to a given MPT issuance (an MPTokenAuthorize was submitted and
// the resulting MPToken object exists), regardless of balance. Mirrors hasTrustLine for the IOU path —
// a holder can be authorized at zero balance, just as a trust line can exist unfunded.
export async function hasMptAuthorization(client: Client, holder: string, mptIssuanceId: string): Promise<boolean> {
  const objs = await accountObjects(client, holder, "mptoken");
  return objs.some((o) => o.MPTokenIssuanceID === mptIssuanceId);
}

// An account flag check, used to make issuer configuration idempotent.
export async function accountHasFlag(client: Client, account: string, flagBit: number): Promise<boolean> {
  try {
    const res = await client.request({ command: "account_info", account, ledger_index: "validated" });
    const flags = res.result.account_data.Flags ?? 0;
    return (flags & flagBit) !== 0;
  } catch {
    return false;
  }
}
