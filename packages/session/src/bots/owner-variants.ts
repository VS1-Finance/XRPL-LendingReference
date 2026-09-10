import { type Client } from "xrpl";
import { deriveAccount, ledgerTimeSeconds, signLoanSetByCounterpartyCPT } from "@lending/shared";
import type { BotContext, BotVariant, StepOutcome } from "./variant.js";
import { idle } from "./variant.js";
import { brokerValue, loanNode, ownerLoanId, maxOriginatable } from "./reads.js";

// tfLoanDefault on LoanManage.
const TF_LOAN_DEFAULT = 65536;

// tfLoanOverpayment on LoanSet — permits overpayment on the originated loan. Bots originate most loans in
// a session, so without this flag on the owner bot's LoanSet the overpay borrower variant would fail with
// tecNO_PERMISSION on every bot-originated loan (the deployed failure mode). Same numeric value as the
// LoanSet overpayment flag; distinct in meaning from TF_LOAN_DEFAULT above (a LoanManage flag).
const TF_LOAN_SET_OVERPAYMENT = 65536;

// The owner behaviour that keeps the lending cycle turning: each round it looks for a borrower without
// a loan and originates one to it, so the market lends unattended rather than waiting for a human to
// play originator. Origination is bilateral — the owner and the borrower counter-sign one LoanSet — so
// this re-derives both wallets from the session seed and combines their signatures, the same path the
// engine's human origination uses. It originates one loan per tick and stands down once every borrower
// already has a loan, so it does not over-lend.
export const loanOriginator = (principal = "10000"): BotVariant => ({
  role: "owner",
  name: "loan-originator",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    // Find a borrower that has no loan yet.
    let target: { address: string; index: number } | undefined;
    for (const b of ctx.session.env.accounts.borrowers) {
      const existing = await ownerLoanId(ctx.session, b.address);
      if (!existing) {
        target = { address: b.address, index: b.index };
        break;
      }
    }
    if (!target) return idle; // every borrower already has a loan

    // Only originate what the vault liquidity and broker cover can actually back, so the bot never
    // submits a loan the ledger will reject for insufficient funds. If there is no headroom, or too
    // little to be worth a loan, stand down this tick rather than fail.
    const headroom = await maxOriginatable(ctx.session);
    if (headroom < 1) return idle;
    const amount = Math.min(Number(principal), Math.floor(headroom)).toString();

    const loanSet = {
      TransactionType: "LoanSet" as const,
      Account: ctx.seat.address,
      LoanBrokerID: ctx.session.env.objects.brokerId!,
      Counterparty: target.address,
      // PrincipalRequested is in the broker's asset units — drops for XRP, whole tokens otherwise.
      PrincipalRequested: brokerValue(ctx.session, amount),
      InterestRate: 50000,
      PaymentInterval: 60,
      GracePeriod: 60,
      LoanOriginationFee: "0",
      Flags: TF_LOAN_SET_OVERPAYMENT,
    };

    // Two raw signatures on one transaction: the owner signs, the borrower counter-signs. Both wallets
    // are re-derived from the seed so the signatures bind to the seats' on-chain identities.
    const ownerWallet = deriveAccount(ctx.session.seed, "owner", ctx.seat.index).wallet;
    const borrowerWallet = deriveAccount(ctx.session.seed, "borrower", target.index).wallet;
    const prepared = await ctx.session.client.autofill(loanSet);
    const ownerSigned = ownerWallet.sign(prepared);
    const combined = signLoanSetByCounterpartyCPT(borrowerWallet, ownerSigned.tx_blob);
    const res = await ctx.session.client.submitAndWait(combined.tx_blob);
    const meta = res.result.meta;
    const code = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
    ctx.log(`owner originate ${amount} to borrower ${target.index} — ${code}`);
    return { acted: true, action: "LoanSet", result: code, hash: res.result.hash };
  },
});

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

// The owner's full behaviour when no human is driving it: each tick it first tries to originate a loan
// to a borrower that has none, and if every borrower is already lent to, it enforces defaults on any
// delinquent loan. Together this runs both sides of the owner's role — lending and enforcement — so
// the whole lifecycle turns unattended.
export const brokerOwner = (): BotVariant => {
  const originate = loanOriginator();
  const enforce = brokerEnforcer();
  return {
    role: "owner",
    name: "broker-owner",
    async tick(ctx: BotContext): Promise<StepOutcome> {
      const originated = await originate.tick(ctx);
      if (originated.acted) return originated;
      return enforce.tick(ctx);
    },
  };
};

// The loan default flag on a loan object; a loan already carrying it is skipped.
const LSF_LOAN_DEFAULTED = 0x00010000;

// Find a loan — held under a borrower's account — that is past its due window with a payment still
// outstanding. Loan objects live in the borrower's directory, so each borrower is scanned.
async function delinquentLoanId(client: Client, borrowers: string[]): Promise<string | undefined> {
  // "Now" is the ledger's own last-validated close time, not the host wall clock, so this bot's view
  // of lateness matches what the ledger enforces. Read once so every loan in this pass uses one time.
  const now = await ledgerTimeSeconds(client);
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
      if (due && now > due + grace) {
        const node = await loanNode(client, String(loan.index));
        if (node && Number(node.PaymentRemaining ?? 0) > 0) return String(loan.index);
      }
    }
  }
  return undefined;
}
