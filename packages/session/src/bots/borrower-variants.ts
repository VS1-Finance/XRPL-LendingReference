import type { BotContext, BotVariant, StepOutcome } from "./variant.js";
import { idle } from "./variant.js";
import { assetAmount, outstandingToPay, payableLoan } from "./reads.js";

// The XRP Ledger epoch (2000-01-01) that ledger time fields are measured from.
const RIPPLE_EPOCH = 946684800;
const nowRipple = (): number => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

// A borrower that pays, but only after the payment is due — modelling a habitually late payer. It
// waits until the current ledger time is past the loan's next-payment due date, then settles.
export const repayLate = (): BotVariant => ({
  role: "borrower",
  name: "repay-late",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const loan = await payableLoan(ctx.session, ctx.seat.address);
    if (!loan) return idle;

    const due = Number(loan.NextPaymentDueDate ?? 0);
    if (due && nowRipple() < due) return idle; // not late yet — hold off until past due

    const amount = outstandingToPay(ctx.session, loan.TotalValueOutstanding);
    const r = await ctx.seat.signer.submit({
      TransactionType: "LoanPay",
      Account: ctx.seat.address,
      LoanID: loan.index as string,
      Amount: assetAmount(ctx.session, amount),
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
    const loan = await payableLoan(ctx.session, ctx.seat.address);
    if (!loan) return idle;

    // Pay the full outstanding plus a fixed overpayment. Both are in whole-token units: the outstanding
    // is normalised out of ledger units first, then the extra is added on top.
    const amount = String(Number(outstandingToPay(ctx.session, loan.TotalValueOutstanding)) + Number(extra));
    const r = await ctx.seat.signer.submit({
      TransactionType: "LoanPay",
      Account: ctx.seat.address,
      LoanID: loan.index as string,
      Amount: assetAmount(ctx.session, amount),
      Flags: TF_LOAN_OVERPAYMENT,
    });
    ctx.log(`borrower ${ctx.seat.index} overpay ${amount} — ${r.engineResult}`);
    return { acted: true, action: "LoanPay", result: r.engineResult, hash: r.hash };
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
    const r = await ctx.seat.signer.submit({
      TransactionType: "LoanPay",
      Account: ctx.seat.address,
      LoanID: loan.index as string,
      Amount: assetAmount(ctx.session, amount),
    });
    ctx.log(`borrower ${ctx.seat.index} early repay ${amount} — ${r.engineResult}`);
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
