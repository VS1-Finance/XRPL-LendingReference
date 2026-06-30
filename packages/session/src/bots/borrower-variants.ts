import { clampIssuedValueUp } from "@lending/shared";
import type { BotContext, BotVariant, StepOutcome } from "./variant.js";
import { idle } from "./variant.js";
import { iouAmount, loanNode, ownerLoanId } from "./reads.js";

// The XRP Ledger epoch (2000-01-01) that ledger time fields are measured from.
const RIPPLE_EPOCH = 946684800;
const nowRipple = (): number => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

// A borrower that pays, but only after the payment is due — modelling a habitually late payer. It
// waits until the current ledger time is past the loan's next-payment due date, then settles.
export const repayLate = (): BotVariant => ({
  role: "borrower",
  name: "repay-late",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const loanId = await ownerLoanId(ctx.session, ctx.seat.address);
    if (!loanId) return idle;
    const loan = await loanNode(ctx.session.client, loanId);
    if (!loan || Number(loan.PaymentRemaining ?? 0) <= 0) return idle;

    const due = Number(loan.NextPaymentDueDate ?? 0);
    if (due && nowRipple() < due) return idle; // not late yet — hold off until past due

    const amount = clampIssuedValueUp(String(loan.TotalValueOutstanding));
    const r = await ctx.seat.signer.submit({
      TransactionType: "LoanPay",
      Account: ctx.seat.address,
      LoanID: loanId,
      Amount: iouAmount(ctx.session, amount),
    });
    ctx.log(`borrower ${ctx.seat.index} late repay ${amount} — ${r.engineResult}`);
    return { acted: true, action: "LoanPay", result: r.engineResult, hash: r.hash };
  },
});

// A borrower that pays more than the amount due. Exercises the overpayment path; the payment carries
// the overpayment flag so the ledger applies its overpayment rule.
const TF_LOAN_OVERPAYMENT = 65536;
export const overpay = (extra = "1000"): BotVariant => ({
  role: "borrower",
  name: "overpay",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const loanId = await ownerLoanId(ctx.session, ctx.seat.address);
    if (!loanId) return idle;
    const loan = await loanNode(ctx.session.client, loanId);
    if (!loan || Number(loan.PaymentRemaining ?? 0) <= 0) return idle;

    const amount = clampIssuedValueUp(String(Number(loan.TotalValueOutstanding) + Number(extra)));
    const r = await ctx.seat.signer.submit({
      TransactionType: "LoanPay",
      Account: ctx.seat.address,
      LoanID: loanId,
      Amount: iouAmount(ctx.session, amount),
      Flags: TF_LOAN_OVERPAYMENT,
    });
    ctx.log(`borrower ${ctx.seat.index} overpay ${amount} — ${r.engineResult}`);
    return { acted: true, action: "LoanPay", result: r.engineResult, hash: r.hash };
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
