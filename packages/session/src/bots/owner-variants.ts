import type { Client } from "xrpl";
import type { BotContext, BotVariant, StepOutcome } from "./variant.js";
import { idle } from "./variant.js";
import { loanNode } from "./reads.js";

// The XRP Ledger epoch (2000-01-01) that ledger time fields are measured from.
const RIPPLE_EPOCH = 946684800;
const nowRipple = (): number => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

// tfLoanDefault on LoanManage.
const TF_LOAN_DEFAULT = 65536;

// The broker-side counterpart to the borrower behaviours. Each round the owner seat looks for a loan
// that is delinquent — past its next-payment due date with a payment still outstanding — and defaults
// it. A borrower that pays on time, late-but-within-window, or early clears its due date before this
// fires, so nothing happens to it; only a loan left unpaid past the window is defaulted. This is what
// turns a defaulting borrower's inaction into an actual on-chain default rather than silence.
export const brokerEnforcer = (): BotVariant => ({
  role: "owner",
  name: "broker-enforcer",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const borrowers = ctx.session.env.accounts.borrowers.map((b) => b.address);
    const loanId = await delinquentLoanId(ctx.session.client, borrowers);
    if (!loanId) return idle;

    const r = await ctx.seat.signer.submit({
      TransactionType: "LoanManage",
      Account: ctx.seat.address,
      LoanID: loanId,
      Flags: TF_LOAN_DEFAULT,
    });
    ctx.log(`owner default loan ${loanId.slice(0, 12)}… — ${r.engineResult}`);
    return { acted: true, action: "LoanManage", result: r.engineResult, hash: r.hash };
  },
});

// The loan default flag on a loan object; a loan already carrying it is skipped.
const LSF_LOAN_DEFAULTED = 0x00010000;

// Find a loan — held under a borrower's account — that is past its due window with a payment still
// outstanding. Loan objects live in the borrower's directory, so each borrower is scanned.
async function delinquentLoanId(client: Client, borrowers: string[]): Promise<string | undefined> {
  for (const borrower of borrowers) {
    const res = await client.request({ command: "account_objects", account: borrower, type: "loan", ledger_index: "validated" });
    const loans = res.result.account_objects as unknown as Record<string, unknown>[];
    for (const loan of loans) {
      if (Number(loan.PaymentRemaining ?? 0) <= 0) continue;
      if ((Number(loan.Flags ?? 0) & LSF_LOAN_DEFAULTED) !== 0) continue;
      // A loan may be defaulted only once the payment due date plus its grace period has elapsed, so
      // the grace window is added before the loan is considered defaultable.
      const due = Number(loan.NextPaymentDueDate ?? 0);
      const grace = Number(loan.GracePeriod ?? 0);
      if (due && nowRipple() > due + grace) {
        const node = await loanNode(client, String(loan.index));
        if (node && Number(node.PaymentRemaining ?? 0) > 0) return String(loan.index);
      }
    }
  }
  return undefined;
}
