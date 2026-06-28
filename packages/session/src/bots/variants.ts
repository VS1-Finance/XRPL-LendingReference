import { clampIssuedValueUp } from "@lending/shared";
import type { BotContext, BotVariant, StepOutcome } from "./variant.js";
import { idle } from "./variant.js";
import { iouAmount, loanNode, ownerLoanId, shareBalance } from "./reads.js";

// A depositor bot that supplies liquidity once and then holds. On each tick it deposits the target
// amount if it holds no shares yet; once it has shares it does nothing further.
export const depositAndHold = (targetValue = "20000"): BotVariant => ({
  role: "depositor",
  name: "deposit-and-hold",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const shareMptId = ctx.session.env.objects.shareMptId!;
    const held = await shareBalance(ctx.session.client, ctx.seat.address, shareMptId);
    if (held > 0n) return idle;

    const r = await ctx.seat.signer.submit({
      TransactionType: "VaultDeposit",
      Account: ctx.seat.address,
      VaultID: ctx.session.env.objects.vaultId!,
      Amount: iouAmount(ctx.session, targetValue),
    });
    ctx.log(`depositor ${ctx.seat.index} deposit ${targetValue} — ${r.engineResult}`);
    return { acted: true, action: "VaultDeposit", result: r.engineResult, hash: r.hash };
  },
});

// A borrower bot that pays its loan on time. It only pays a loan that already exists (origination is
// bilateral and driven from the owner/broker side), and pays the outstanding amount to settle it.
export const repayOnTime = (): BotVariant => ({
  role: "borrower",
  name: "repay-on-time",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const loanId = await ownerLoanId(ctx.session, ctx.seat.address);
    if (!loanId) return idle;
    const loan = await loanNode(ctx.session.client, loanId);
    if (!loan || Number(loan.PaymentRemaining ?? 0) <= 0) return idle;

    const due = clampIssuedValueUp(String(loan.TotalValueOutstanding));
    const r = await ctx.seat.signer.submit({
      TransactionType: "LoanPay",
      Account: ctx.seat.address,
      LoanID: loanId,
      Amount: iouAmount(ctx.session, due),
    });
    ctx.log(`borrower ${ctx.seat.index} repay ${due} — ${r.engineResult}`);
    return { acted: true, action: "LoanPay", result: r.engineResult, hash: r.hash };
  },
});

// The default set of variants assigned to bot seats, one per pooled role.
export function defaultVariants(): BotVariant[] {
  return [depositAndHold(), repayOnTime()];
}
