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

// Reads a ledger amount that may be a bare string or an issued-amount object with a `value`.
function readAmount(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) return String((value as { value: unknown }).value);
  return "0";
}

export function iouAmount(session: Session, value: string): { currency: string; issuer: string; value: string } {
  const { currency, issuer } = session.env.asset;
  if (!issuer) throw new Error("session asset has no issuer");
  return { currency, issuer, value };
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

// The spare capacity a deposit can still fill: the vault's maximum assets minus its current total. A
// vault with no maximum set has unlimited room. Returns 0 (or less) when the vault is at its cap, so a
// depositor bot can hold instead of depositing into a full vault (which the ledger rejects).
export async function vaultDepositHeadroom(session: Session): Promise<number> {
  const vault = await ownerObject(session, "vault");
  if (!vault) return 0;
  const max = readNumber(vault.AssetsMaximum);
  if (!max) return Infinity; // no cap configured
  return max - readNumber(vault.AssetsTotal);
}

// The largest new loan the broker can currently back, given the vault's available liquidity and the
// broker's cover headroom at its minimum cover rate. A loan may not exceed the vault's spare assets,
// and its principal plus existing debt must stay within what the cover supports. Returns 0 when
// nothing more can be lent. Rates are scaled integers where 100000 is 100%.
export async function maxOriginatable(session: Session): Promise<number> {
  const vault = await ownerObject(session, "vault");
  const broker = await ownerObject(session, "loan_broker");
  if (!vault || !broker) return 0;

  const available = readNumber(vault.AssetsAvailable);
  const coverAvailable = readNumber(broker.CoverAvailable);
  const debtTotal = readNumber(broker.DebtTotal);
  const debtMaximum = readNumber(broker.DebtMaximum);
  const coverRate = readNumber(broker.CoverRateMinimum) || 100000;

  // Debt the cover can support in total, minus what is already lent.
  const coverSupportsTotal = (coverAvailable * 100000) / coverRate;
  const coverHeadroom = coverSupportsTotal - debtTotal;
  const debtHeadroom = debtMaximum > 0 ? debtMaximum - debtTotal : Infinity;

  return Math.max(0, Math.min(available, coverHeadroom, debtHeadroom));
}
