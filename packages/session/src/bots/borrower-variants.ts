import type { SubmittableTransaction } from "xrpl";
import { ledgerTimeSeconds } from "@lending/shared";
import type { BotContext, BotVariant, StepOutcome } from "./variant.js";
import { idle } from "./variant.js";
import { assetAmount, outstandingToPay, payableLoan, loanDefaulted, repayHeadroom } from "./reads.js";

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
    // Past the due date, so the payment must carry tfLoanLatePayment or the ledger rejects it (tecEXPIRED).
    return submitRepay(ctx, loan.index as string, amount, "late repay", TF_LOAN_LATE_PAYMENT);
  },
});

// LoanPay flags, one per payment (the ledger allows at most one of these on a single LoanPay). Each tells
// the ledger which payment rule to apply; without the matching flag the corresponding action is rejected:
// an overpayment without tfLoanOverpayment → tecNO_PERMISSION, a payment after the due date without
// tfLoanLatePayment → tecEXPIRED, an early full settlement without tfLoanFullPayment cannot close the loan.
const TF_LOAN_OVERPAYMENT = 65536; // tfLoanOverpayment — pay more than the scheduled amount
const TF_LOAN_FULL_PAYMENT = 131072; // tfLoanFullPayment — settle the whole outstanding balance at once
const TF_LOAN_LATE_PAYMENT = 262144; // tfLoanLatePayment — pay after the payment due date has passed

// A borrower that pays more than the amount due. Exercises the overpayment path; the payment carries
// the overpayment flag so the ledger applies its overpayment rule.
export const overpay = (extra = "1000"): BotVariant => ({
  role: "borrower",
  name: "overpay",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const loan = await payableLoan(ctx.session, ctx.seat.address);
    if (!loan) return idle;

    // Pay the full outstanding plus a fixed overpayment, both in whole-token units (the outstanding is
    // normalised out of ledger units first, then the extra is added on top). But cap the total at what
    // the borrower can actually afford: for an XRP loan a payment above the account's spendable balance
    // is a guaranteed rejection (tecUNFUNDED, or tecNO_PERMISSION once the loan impairs while the bot
    // retries), which wedges the loan permanently. Never drop below the outstanding, so the loan still
    // settles in full even when the borrower cannot cover the extra — it just overpays by less (or not
    // at all). IOU/MPT borrowers are minted enough to cover their debt, so their headroom is unbounded.
    const outstanding = Number(outstandingToPay(ctx.session, loan.TotalValueOutstanding));
    const affordable = await repayHeadroom(ctx.session, ctx.seat.address);
    const amount = String(Math.max(outstanding, Math.min(outstanding + Number(extra), affordable)));
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
    // Settling the whole balance ahead of schedule: carry tfLoanFullPayment so the ledger closes the loan
    // in one payment rather than treating it as a single scheduled instalment.
    return submitRepay(ctx, loan.index as string, amount, "early repay", TF_LOAN_FULL_PAYMENT);
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
