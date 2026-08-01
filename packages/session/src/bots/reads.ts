import { xrpToDrops, type Amount, type Client } from "xrpl";
import { clampIssuedValueUp, dropsToXrpString } from "@lending/shared";
import type { Session } from "../session.js";

// Whether the session asset is native XRP (currency "XRP" with no issuer) rather than an issued token.
function isXrp(session: Session): boolean {
  const { currency, issuer } = session.env.asset;
  return currency === "XRP" && !issuer;
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
// string; for an issued token it is a currency/issuer/value object. Bots reason in whole-token units
// everywhere, so this is the single point where those units become a ledger Amount.
export function assetAmount(session: Session, value: string): Amount {
  if (isXrp(session)) return xrpToDrops(value);
  const { currency, issuer } = session.env.asset;
  if (!issuer) throw new Error("session asset has no issuer");
  return { currency, issuer, value };
}

// A whole-token value expressed in the broker's asset units as a bare string, for fields that take a
// plain number rather than a full Amount (the loan principal): drops for XRP, whole tokens otherwise.
export function brokerValue(session: Session, value: string): string {
  return isXrp(session) ? xrpToDrops(value) : value;
}

// The whole-token amount to repay for a loan, from its on-ledger outstanding balance. XRP balances are
// integer drops and convert cleanly to whole XRP; issued balances are clamped up to the ledger's
// 15-significant-digit limit so a derived repayment never falls a sub-unit short of what is owed.
export function outstandingToPay(session: Session, outstanding: unknown): string {
  const ledgerValue = readAmount(outstanding);
  return isXrp(session) ? dropsToXrpString(ledgerValue) : clampIssuedValueUp(ledgerValue);
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
// they are divided down to whole XRP; issued amounts are already in token units. Used by the headroom
// reads below so bot arithmetic stays in whole-token space regardless of asset kind.
function readWholeTokens(session: Session, value: unknown): number {
  return isXrp(session) ? readNumber(value) / 1_000_000 : readNumber(value);
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
