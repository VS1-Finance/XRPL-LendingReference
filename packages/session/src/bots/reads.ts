import { xrpToDrops, type Amount, type Client, type MPTAmount } from "xrpl";
import { clampIssuedValueUp, decimalToScaled, dropsToXrpString, scaledToDecimal, vaultPhase, ledgerTimeSeconds } from "@lending/shared";
import type { Session } from "../session.js";

// Whether the session asset is native XRP (currency "XRP" with no issuer) rather than an issued token.
function isXrp(session: Session): boolean {
  const { currency, issuer } = session.env.asset;
  return currency === "XRP" && !issuer;
}

// Whether the session asset is an MPT vault asset (currency "MPT", identified by env.objects.assetMptId
// rather than a currency/issuer pair).
function isMpt(session: Session): boolean {
  return session.env.asset.currency === "MPT";
}

// The scale the session's vault-asset MPT issuance was actually created at, read back from env (not
// config or a const — a session could have been provisioned at any scale). Bots reason in whole-token
// units and need this scale to shape a raw integer MPT amount from/to a whole-token value.
function mptAssetScale(session: Session): number {
  return session.env.objects.assetScale ?? 2;
}

// Small validated-ledger reads used by bot variants to decide whether to act. Kept here so the
// variants stay strategy-only.

export async function shareBalance(client: Client, holder: string, shareMptId: string): Promise<bigint> {
  const res = await client.request({ command: "account_objects", account: holder, type: "mptoken", ledger_index: "validated" });
  const objs = res.result.account_objects as unknown as Record<string, unknown>[];
  const share = objs.find((o) => o.MPTokenIssuanceID === shareMptId);
  return BigInt((share?.MPTAmount as string | undefined) ?? "0");
}

// The id of a loan held by a specific borrower, if any. Loan objects live in the borrower's own
// account directory, so only that account is scanned — scanning the owner would return some other
// borrower's loan and lead a borrower to pay into a loan that is not theirs (a tecINTERNAL rejection).
export async function ownerLoanId(session: Session, borrower: string): Promise<string | undefined> {
  const res = await session.client.request({ command: "account_objects", account: borrower, type: "loan", ledger_index: "validated" });
  const objs = res.result.account_objects as unknown as Record<string, unknown>[];
  return objs[0]?.index as string | undefined;
}

export async function loanNode(client: Client, loanId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await client.request({ command: "ledger_entry", index: loanId, ledger_index: "validated" });
    return res.result.node as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// The loan default flag on a loan object.
const LSF_LOAN_DEFAULTED = 0x00010000;

// A borrower's loan node only if it can actually be paid right now: it exists, is not defaulted, still
// has a payment remaining, AND has a positive outstanding balance. A freshly originated loan appears
// on-ledger a tick before its outstanding-balance fields are populated; paying it then produces a
// malformed amount and a tecINTERNAL rejection, so the loan is treated as not-yet-payable until the
// balance is present. Paying a closed or defaulted loan is likewise rejected, so both are excluded.
export async function payableLoan(session: Session, borrower: string): Promise<Record<string, unknown> | undefined> {
  const loanId = await ownerLoanId(session, borrower);
  if (!loanId) return undefined;
  const loan = await loanNode(session.client, loanId);
  if (!loan) return undefined;
  if ((Number(loan.Flags ?? 0) & LSF_LOAN_DEFAULTED) !== 0) return undefined;
  if (Number(loan.PaymentRemaining ?? 0) <= 0) return undefined;
  // The outstanding balance must be present and positive before a repayment can be computed.
  const outstanding = loan.TotalValueOutstanding;
  if (outstanding === undefined || outstanding === null || !(Number(readAmount(outstanding)) > 0)) return undefined;
  return loan;
}

// A fresh re-read of whether a loan is defaulted, for a borrower bot to check immediately before
// submitting a repayment. payableLoan's own defaulted check can go stale across a ledger boundary if
// the broker-enforcer bot defaults the loan in between; re-checking here avoids sending a repayment
// the ledger would reject with tecNO_PERMISSION. Missing loan is treated as defaulted (nothing to pay).
export async function loanDefaulted(client: Client, loanId: string): Promise<boolean> {
  const loan = await loanNode(client, loanId);
  if (!loan) return true;
  return (Number(loan.Flags ?? 0) & LSF_LOAN_DEFAULTED) !== 0;
}

// Reads a ledger amount that may be a bare string or an issued-amount object with a `value`.
function readAmount(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) return String((value as { value: unknown }).value);
  return "0";
}

// Builds a ledger Amount for the session's asset from a whole-token value. For XRP that is a bare drops
// string; for MPT it is an mpt_issuance_id/value object with the value scaled to the issuance's raw
// integer units; for an issued token it is a currency/issuer/value object. Bots reason in whole-token
// units everywhere, so this is the single point where those units become a ledger Amount.
export function assetAmount(session: Session, value: string): Amount | MPTAmount {
  if (isXrp(session)) return xrpToDrops(value);
  if (isMpt(session)) {
    const mptIssuanceId = session.env.objects.assetMptId;
    if (!mptIssuanceId) throw new Error("session asset is MPT but has no assetMptId");
    return { mpt_issuance_id: mptIssuanceId, value: decimalToScaled(value, mptAssetScale(session)).toString() };
  }
  const { currency, issuer } = session.env.asset;
  if (!issuer) throw new Error("session asset has no issuer");
  return { currency, issuer, value };
}

// A whole-token value expressed in the broker's asset units as a bare string, for fields that take a
// plain number rather than a full Amount (the loan principal): drops for XRP, the issuance's raw
// integer units for MPT, whole tokens otherwise.
export function brokerValue(session: Session, value: string): string {
  if (isXrp(session)) return xrpToDrops(value);
  if (isMpt(session)) return decimalToScaled(value, mptAssetScale(session)).toString();
  return value;
}

// The whole-token amount to repay for a loan, from its on-ledger outstanding balance. XRP balances are
// integer drops and convert cleanly to whole XRP; MPT balances are raw integers at the vault's actual
// assetScale and convert cleanly to whole tokens; issued balances are clamped up to the ledger's
// 15-significant-digit limit so a derived repayment never falls a sub-unit short of what is owed.
export function outstandingToPay(session: Session, outstanding: unknown): string {
  const ledgerValue = readAmount(outstanding);
  if (isXrp(session)) return dropsToXrpString(ledgerValue);
  if (isMpt(session)) return scaledMptToWhole(session, ledgerValue);
  return clampIssuedValueUp(ledgerValue);
}

// Converts a raw MPT integer amount (as it appears on-ledger, e.g. TotalValueOutstanding) to a
// whole-token decimal string, in exact integer arithmetic (no float division), at the vault's actual
// assetScale (read back from env, not a const).
function scaledMptToWhole(session: Session, value: string): string {
  return scaledToDecimal(BigInt(value), mptAssetScale(session));
}

// Reads a single account object of a given type from the owner's account (the vault and broker both
// live under the owner). Returns undefined if the object is not present yet.
async function ownerObject(session: Session, type: "vault" | "loan_broker"): Promise<Record<string, unknown> | undefined> {
  const res = await session.client.request({
    command: "account_objects",
    account: session.env.accounts.owner.address,
    type,
    ledger_index: "validated",
  });
  return (res.result.account_objects as unknown as Record<string, unknown>[])[0];
}

function readNumber(value: unknown): number {
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "value" in value) return Number((value as { value: unknown }).value);
  return 0;
}

// Reads a ledger amount field as a whole-token number. XRP amounts come off the ledger in drops, so
// they are divided down to whole XRP; MPT amounts come off the ledger as raw integers at the vault's
// actual assetScale, so they are divided down by that scale; issued amounts are already in token units.
// Used by the headroom reads below so bot arithmetic stays in whole-token space regardless of asset kind.
function readWholeTokens(session: Session, value: unknown): number {
  if (isXrp(session)) return readNumber(value) / 1_000_000;
  if (isMpt(session)) return readNumber(value) / 10 ** mptAssetScale(session);
  return readNumber(value);
}

// The spare capacity a deposit can still fill: the vault's maximum assets minus its current total. A
// vault with no maximum set has unlimited room. Returns 0 (or less) when the vault is at its cap, so a
// depositor bot can hold instead of depositing into a full vault (which the ledger rejects).
export async function vaultDepositHeadroom(session: Session): Promise<number> {
  const vault = await ownerObject(session, "vault");
  if (!vault) return 0;
  const max = readWholeTokens(session, vault.AssetsMaximum);
  if (!max) return Infinity; // no cap configured
  return max - readWholeTokens(session, vault.AssetsTotal);
}

// The most a holder can actually deposit right now: the vault's spare room, and for an XRP vault also
// bounded by what the account can spend without dipping below its reserve. An IOU holder's minted
// balance always covers its target, so the vault headroom alone applies there; an XRP holder deposits
// real XRP, so a deposit is never larger than its spendable balance (avoiding a tecUNFUNDED when the
// configured liquidity is smaller than a bot's target).
export async function depositHeadroom(session: Session, holder: string): Promise<number> {
  const vaultRoom = await vaultDepositHeadroom(session);
  if (!isXrp(session)) return vaultRoom;
  const info = await session.client.request({ command: "account_info", account: holder, ledger_index: "validated" });
  const balanceDrops = Number(info.result.account_data.Balance);
  const ownerCount = Number(info.result.account_data.OwnerCount ?? 0);
  // Leave the base+owner reserve and a small fee/new-object buffer (2 XRP) untouched.
  const reserveDrops = 1_000_000 + 200_000 * (ownerCount + 1) + 2_000_000;
  const spendable = Math.max(0, (balanceDrops - reserveDrops) / 1_000_000);
  return Math.min(vaultRoom, spendable);
}

// The most a borrower can actually pay toward its loan right now, in whole-token units. For an XRP loan
// the borrower pays real XRP, so a payment can never exceed what the account can spend without dipping
// below its reserve (mirroring depositHeadroom) — an overpayment past that is a guaranteed tecUNFUNDED /
// unaffordable rejection. For an IOU or MPT loan the borrower was minted enough at provisioning to cover
// its debt, so balance is not the binding constraint and the headroom is unbounded (Infinity). This is
// the ceiling an overpaying bot must cap its payment to, so it never asks the ledger for more than it holds.
export async function repayHeadroom(session: Session, borrower: string): Promise<number> {
  if (!isXrp(session)) return Infinity;
  const info = await session.client.request({ command: "account_info", account: borrower, ledger_index: "validated" });
  const balanceDrops = Number(info.result.account_data.Balance);
  const ownerCount = Number(info.result.account_data.OwnerCount ?? 0);
  // Leave the base+owner reserve and a small fee buffer (2 XRP) untouched, exactly as depositHeadroom does.
  const reserveDrops = 1_000_000 + 200_000 * (ownerCount + 1) + 2_000_000;
  return Math.max(0, (balanceDrops - reserveDrops) / 1_000_000);
}

// The largest new loan the broker can currently back, given the vault's available liquidity and the
// broker's cover headroom at its minimum cover rate. A loan may not exceed the vault's spare assets,
// and its principal plus existing debt must stay within what the cover supports. Returns 0 when
// nothing more can be lent. Rates are scaled integers where 100000 is 100%.
export async function maxOriginatable(session: Session): Promise<number> {
  const vault = await ownerObject(session, "vault");
  const broker = await ownerObject(session, "loan_broker");
  if (!vault || !broker) return 0;

  // Asset-denominated fields are read in whole-token units so the result can be compared against the
  // bot's whole-token target; the cover rate is a scaled integer (100000 = 100%) and stays as-is.
  const available = readWholeTokens(session, vault.AssetsAvailable);
  const coverAvailable = readWholeTokens(session, broker.CoverAvailable);
  const debtTotal = readWholeTokens(session, broker.DebtTotal);
  const debtMaximum = readWholeTokens(session, broker.DebtMaximum);
  const coverRate = readNumber(broker.CoverRateMinimum) || 100000;

  // Debt the cover can support in total, minus what is already lent.
  const coverSupportsTotal = (coverAvailable * 100000) / coverRate;
  const coverHeadroom = coverSupportsTotal - debtTotal;
  const debtHeadroom = debtMaximum > 0 ? debtMaximum - debtTotal : Infinity;

  const ceiling = Math.min(available, coverHeadroom, debtHeadroom);
  // Leave a margin below the cover ceiling. The ledger backs a loan's whole outstanding balance —
  // principal plus accruing interest — against cover, so a principal originated at the exact ceiling
  // is rejected (tecLIMIT_EXCEEDED) the moment any interest accrues. Originate at most 80% of the
  // headroom so principal plus interest stays within cover for the bot's loan terms.
  return Math.max(0, Math.floor(ceiling * 0.8));
}

// The vault phase now, for a closed-ended vault, used by phase-gated bots to check if they should act.
// Returns "subscription", "investment", "redemption", or null if the vault is not closed-ended or not found.
export async function vaultPhaseNow(session: Session): Promise<ReturnType<typeof vaultPhase>> {
  const vault = await ownerObject(session, "vault");
  if (!vault) return null;
  const now = await ledgerTimeSeconds(session.client);
  return vaultPhase(vault, now);
}
