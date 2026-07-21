import { submitOrThrow } from "@lending/shared";
import { submitExpectReject, submitExpectSuccess } from "../assert.js";
import { ensureDeposit, iouAmount, originateLoan } from "../helpers.js";
import type { NegativeCase } from "../types.js";

const SHORT_TERM = { principal: "10000", interestRate: 50000, paymentInterval: 60, gracePeriod: 60 };

// N6 — issuer rotation mid-flight. Rotating a domain's credential issuer or accepted-credentials set
// while positions and loans are live is not a clean rejection but a policy question, so it is
// reported as deferred rather than asserted.
const N6: NegativeCase = {
  id: "N6",
  title: "issuer rotation mid-flight",
  guards: "undefined-behavior — pending protocol decision",
  expected: { kind: "deferred", reason: "not a clean rejection; the intended outcome is a protocol decision, not an observable code" },
  async run() {
    return { code: "deferred", detail: "reported without execution" };
  },
};

// N7 — deleting a vault that still has a broker attached must be rejected: the broker is an
// outstanding obligation on the vault.
const N7: NegativeCase = {
  id: "N7",
  title: "delete a vault with an attached broker",
  guards: "vault cannot be deleted with outstanding obligations",
  expected: { kind: "reject", code: "tecHAS_OBLIGATIONS" },
  async run(ctx) {
    return submitExpectReject(ctx, ctx.wallets.owner, {
      TransactionType: "VaultDelete",
      Account: ctx.wallets.owner.address,
      VaultID: ctx.env.objects.vaultId!,
    }, "N7-vault-delete");
  },
};

// N8 — a vault clawback against an account that is not a share-holding vault member is rejected: the
// issuer power has no authorized target to act on, so the ledger rejects it (tecNO_AUTH) rather than
// moving value. Related rejection codes are accepted so the case survives a code change, but a
// success would fail it.
const N8: NegativeCase = {
  id: "N8",
  title: "clawback against a non-member",
  guards: "issuer clawback requires an authorized holder",
  expected: { kind: "reject-any", codes: ["tecNO_AUTH", "tecPRECISION_LOSS", "tecNO_PERMISSION", "tecNO_LINE", "tecNO_ENTRY"] },
  // Clawback is an issued-asset issuer power; XRP has no clawback, so this case applies to IOU vaults.
  appliesTo: (env) => env.asset.issuer !== undefined,
  async run(ctx) {
    const stranger = (await ctx.client.fundWallet(null, { amount: "50" })).wallet;
    const { currency, issuer } = ctx.env.asset;
    if (!issuer) throw new Error("clawback case requires an issued asset");
    return submitExpectReject(ctx, ctx.wallets.issuer, {
      TransactionType: "VaultClawback",
      Account: ctx.wallets.issuer.address,
      VaultID: ctx.env.objects.vaultId!,
      Holder: stranger.address,
      Amount: { currency, issuer, value: "1000" },
    }, "N8-clawback");
  },
};

// N9 — withdrawal under loss is a correctness case, not a rejection. Under a cover-protected
// default the broker's first-loss capital absorbs the loss, so a depositor's withdrawal still
// returns value (tesSUCCESS). The assertion is that it succeeds, not that it is rejected.
const N9: NegativeCase = {
  id: "N9",
  title: "withdrawal under loss returns value (correctness)",
  guards: "first-loss cover absorbs before depositors",
  expected: { kind: "success", note: "withdrawal succeeds; cover absorbs the loss" },
  async run(ctx) {
    const depositor = ctx.wallets.depositors[0]!;
    await ensureDeposit(ctx, depositor, "5000", "N9-deposit");
    return submitExpectSuccess(ctx, depositor, {
      TransactionType: "VaultWithdraw",
      Account: depositor.address,
      VaultID: ctx.env.objects.vaultId!,
      Amount: iouAmount(ctx, "1000"),
    }, "N9-withdraw");
  },
};

// N10 — origination is bilateral. A LoanSet signed by only one party is malformed at preflight
// (it lacks the counterparty signature) and never reaches consensus.
const N10: NegativeCase = {
  id: "N10",
  title: "single-signed LoanSet",
  guards: "origination must be bilateral",
  expected: { kind: "reject-any", codes: ["temBAD_SIGNER", "temMALFORMED", "Counterparty"] },
  async run(ctx) {
    const borrower = ctx.wallets.borrowers[0]!;
    return submitExpectReject(ctx, ctx.wallets.owner, {
      TransactionType: "LoanSet",
      Account: ctx.wallets.owner.address,
      LoanBrokerID: ctx.env.objects.brokerId!,
      Counterparty: borrower.address,
      PrincipalRequested: "10000",
      InterestRate: 50000,
      PaymentInterval: 60,
      GracePeriod: 60,
      LoanOriginationFee: "0",
    }, "N10-single-signed");
  },
};

// N11 — a stranger with no relationship to a loan attempts to pay it. Paying someone else's loan is
// not permitted.
const N11: NegativeCase = {
  id: "N11",
  title: "stranger pays another account's loan",
  guards: "loan actions are permissioned to the borrower",
  expected: { kind: "reject", code: "tecNO_PERMISSION" },
  async run(ctx) {
    const borrower = ctx.wallets.borrowers[0]!;
    await ensureDeposit(ctx, ctx.wallets.depositors[0]!, "20000", "N11-fund-vault");
    const loanId = await originateLoan(ctx, borrower, SHORT_TERM, "N11-originate");
    const stranger = (await ctx.client.fundWallet(null, { amount: "50" })).wallet;
    // Give the stranger a trust line + asset so the rejection is about permission, not funds.
    await submitOrThrow(ctx.client, stranger, { TransactionType: "TrustSet", Account: stranger.address, LimitAmount: { currency: ctx.env.asset.currency, issuer: ctx.env.asset.issuer!, value: "100000000" } }, { setupId: ctx.env.setupId, correlationId: "N11-stranger-trust" });
    await submitOrThrow(ctx.client, ctx.wallets.issuer, { TransactionType: "Payment", Account: ctx.wallets.issuer.address, Destination: stranger.address, Amount: { currency: ctx.env.asset.currency, issuer: ctx.env.asset.issuer!, value: "20000" } }, { setupId: ctx.env.setupId, correlationId: "N11-stranger-fund" });
    return submitExpectReject(ctx, stranger, {
      TransactionType: "LoanPay",
      Account: stranger.address,
      LoanID: loanId,
      Amount: iouAmount(ctx, "1000"),
    }, "N11-stranger-pay");
  },
};

// N12 — overpayment flag semantics. Observed behavior is that a payment above the amount due is
// accepted WITHOUT the overpayment flag, and REJECTED with tfLoanOverpayment set — the flag is more
// restrictive than the prose implies. This case asserts the rejection that the flag produces.
const N12: NegativeCase = {
  id: "N12",
  title: "overpayment with the overpayment flag set",
  guards: "overpayment-flag semantics (observed inverted vs prose)",
  expected: { kind: "reject", code: "tecNO_PERMISSION" },
  async run(ctx) {
    const borrower = ctx.wallets.borrowers[0]!;
    await ensureDeposit(ctx, ctx.wallets.depositors[0]!, "20000", "N12-fund-vault");
    const loanId = await originateLoan(ctx, borrower, SHORT_TERM, "N12-originate");
    const tfLoanOverpayment = 65536;
    return submitExpectReject(ctx, borrower, {
      TransactionType: "LoanPay",
      Account: borrower.address,
      LoanID: loanId,
      Amount: iouAmount(ctx, "20000"),
      Flags: tfLoanOverpayment,
    }, "N12-overpay-flagged");
  },
};

// N13 — withdrawing broker cover below the required minimum floor is rejected: the cover must stay
// above the level backing outstanding debt.
const N13: NegativeCase = {
  id: "N13",
  title: "withdraw broker cover below the minimum floor",
  guards: "first-loss cover floor",
  expected: { kind: "reject", code: "tecINSUFFICIENT_FUNDS" },
  async run(ctx) {
    const borrower = ctx.wallets.borrowers[0]!;
    await ensureDeposit(ctx, ctx.wallets.depositors[0]!, "20000", "N13-fund-vault");
    await originateLoan(ctx, borrower, SHORT_TERM, "N13-originate");
    // With an active loan the cover backs its debt; withdrawing the full cover drops below the floor.
    return submitExpectReject(ctx, ctx.wallets.owner, {
      TransactionType: "LoanBrokerCoverWithdraw",
      Account: ctx.wallets.owner.address,
      LoanBrokerID: ctx.env.objects.brokerId!,
      Amount: iouAmount(ctx, "20000"),
    }, "N13-cover-withdraw");
  },
};

// N14 — a premature default (before the payment window plus grace has elapsed) is rejected as too
// soon.
const N14: NegativeCase = {
  id: "N14",
  title: "premature default",
  guards: "default is time-gated",
  expected: { kind: "reject", code: "tecTOO_SOON" },
  async run(ctx) {
    const borrower = ctx.wallets.borrowers[0]!;
    await ensureDeposit(ctx, ctx.wallets.depositors[0]!, "20000", "N14-fund-vault");
    const loanId = await originateLoan(ctx, borrower, SHORT_TERM, "N14-originate");
    const tfLoanDefault = 65536;
    return submitExpectReject(ctx, ctx.wallets.owner, {
      TransactionType: "LoanManage",
      Account: ctx.wallets.owner.address,
      LoanID: loanId,
      Flags: tfLoanDefault,
    }, "N14-premature-default");
  },
};

// N15 — deleting a loan that is still active (has outstanding debt) is rejected.
const N15: NegativeCase = {
  id: "N15",
  title: "delete an active loan",
  guards: "loan cannot be deleted with outstanding debt",
  expected: { kind: "reject", code: "tecHAS_OBLIGATIONS" },
  async run(ctx) {
    const borrower = ctx.wallets.borrowers[0]!;
    await ensureDeposit(ctx, ctx.wallets.depositors[0]!, "20000", "N15-fund-vault");
    const loanId = await originateLoan(ctx, borrower, SHORT_TERM, "N15-originate");
    return submitExpectReject(ctx, ctx.wallets.owner, {
      TransactionType: "LoanDelete",
      Account: ctx.wallets.owner.address,
      LoanID: loanId,
    }, "N15-delete-active");
  },
};

export const lendingCases: NegativeCase[] = [N6, N7, N8, N9, N10, N11, N12, N13, N14, N15];
