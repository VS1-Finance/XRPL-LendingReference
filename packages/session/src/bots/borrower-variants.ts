import type { SubmittableTransaction } from "xrpl";
import { ledgerTimeSeconds } from "@lending/shared";
import type { BotContext, BotVariant, StepOutcome } from "./variant.js";
import { idle } from "./variant.js";
import { assetAmount, outstandingToPay, payableLoan, loanDefaulted } from "./reads.js";

// Submit a borrower's LoanPay, guarding the read-then-submit window against the broker-enforcer bot.
// payableLoan already excludes defaulted loans, but the enforcer can default the loan between that read
// and this submit (a cross-account race over a ledger boundary). Re-check right before submitting, and
// if the submit still lands on a now-defaulted loan (tecNO_PERMISSION), treat it as an expected no-op
// rather than a logged failure — the repayment was simply overtaken by the default.
async function submitRepay(
  ctx: BotContext,
  loanId: string,
  amount: string,
  label: string,
  flags?: number,
): Promise<StepOutcome> {
  if (await loanDefaulted(ctx.session.client, loanId)) return idle; // defaulted since payableLoan read
  const tx = {
    TransactionType: "LoanPay",
    Account: ctx.seat.address,
    LoanID: loanId,
    Amount: assetAmount(ctx.session, amount),
    ...(flags !== undefined ? { Flags: flags } : {}),
  } as SubmittableTransaction;
  const r = await ctx.seat.signer.submit(tx);
  if (r.engineResult === "tecNO_PERMISSION" && (await loanDefaulted(ctx.session.client, loanId))) {
    ctx.log(`borrower ${ctx.seat.index} ${label} — loan defaulted mid-round, skipped`);
    return idle;
  }
  ctx.log(`borrower ${ctx.seat.index} ${label} ${amount} — ${r.engineResult}`);
  return { acted: true, action: "LoanPay", result: r.engineResult, hash: r.hash };
}

// A borrower that pays, but only after the payment is due — modelling a habitually late payer. It
// waits until the current ledger time is past the loan's next-payment due date, then settles.
export const repayLate = (): BotVariant => ({
  role: "borrower",
  name: "repay-late",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const loan = await payableLoan(ctx.session, ctx.seat.address);
    if (!loan) return idle;

    const due = Number(loan.NextPaymentDueDate ?? 0);
    // Compare against the ledger's own close time, not the host wall clock, so "past due" matches what
    // the ledger enforces.
    const now = await ledgerTimeSeconds(ctx.session.client);
    if (due && now < due) return idle; // not late yet — hold off until past due

    const amount = outstandingToPay(ctx.session, loan.TotalValueOutstanding);
    return submitRepay(ctx, loan.index as string, amount, "late repay");
  },
});

// A borrower that pays more than the amount due. Exercises the overpayment path; the payment carries
// the overpayment flag so the ledger applies its overpayment rule.
const TF_LOAN_OVERPAYMENT = 65536;
export const overpay = (extra = "1000"): BotVariant => ({
  role: "borrower",
  name: "overpay",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const loan = await payableLoan(ctx.session, ctx.seat.address);
    if (!loan) return idle;

    // Pay the full outstanding plus a fixed overpayment. Both are in whole-token units: the outstanding
    // is normalised out of ledger units first, then the extra is added on top.
    const amount = String(Number(outstandingToPay(ctx.session, loan.TotalValueOutstanding)) + Number(extra));
    return submitRepay(ctx, loan.index as string, amount, "overpay", TF_LOAN_OVERPAYMENT);
  },
});

// A borrower that repays early: it settles the loan in full as soon as it exists, without waiting
// for the payment schedule. Models a borrower clearing debt ahead of term.
export const repayEarly = (): BotVariant => ({
  role: "borrower",
  name: "repay-early",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const loan = await payableLoan(ctx.session, ctx.seat.address);
    if (!loan) return idle;

    const amount = outstandingToPay(ctx.session, loan.TotalValueOutstanding);
    return submitRepay(ctx, loan.index as string, amount, "early repay");
  },
});

// A borrower that never pays. The behaviour is the absence of payment, so the variant simply holds;
// the loan is left to be defaulted from the broker side once its window elapses.
export const defaulter = (): BotVariant => ({
  role: "borrower",
  name: "default",
  async tick(): Promise<StepOutcome> {
    return idle;
  },
});
