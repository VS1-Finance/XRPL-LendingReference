import { Wallet, signLoanSetByCounterparty, xrpToDrops, type Amount } from "xrpl";
import { buildMemos, submitOrThrow, withRetry, type SubmitContext } from "@lending/shared";
import type { CaseContext } from "./types.js";

// A credential type is readable ASCII in config and hex on the ledger.
export function encodeCredentialType(type: string): string {
  return Buffer.from(type, "utf8").toString("hex").toUpperCase();
}

// The environment's asset as an Amount, from a whole-token value. XRP is a bare drops string; an
// issued asset is a currency/issuer/value object. (Kept named iouAmount for call-site continuity.)
export function iouAmount(ctx: CaseContext, value: string): Amount {
  const { currency, issuer } = ctx.env.asset;
  if (currency === "XRP" && !issuer) return xrpToDrops(value);
  if (!issuer) throw new Error("issued asset has no issuer in the provisioned graph");
  return { currency, issuer, value };
}

// Fund a fresh outsider account from the faucet, give it a trust line to the environment's issuer,
// and distribute some of the asset — so the account is capable of a deposit in every respect except
// domain membership. Used by the deposit-gating cases to prove the gate is what rejects them.
export async function fundOutsider(ctx: CaseContext, distributeValue = "10000"): Promise<Wallet> {
  const { wallet } = await withRetry(() => ctx.client.fundWallet(null, { amount: "50" }), {
    retryable: (e) => /timeout|econn|socket|network|disconnect|rate|429|faucet/i.test(String(e)),
  });
  const asset = ctx.env.asset;
  const trustCtx: SubmitContext = { setupId: ctx.env.setupId, correlationId: "outsider-trust" };
  await submitOrThrow(ctx.client, wallet, {
    TransactionType: "TrustSet",
    Account: wallet.address,
    LimitAmount: { currency: asset.currency, issuer: asset.issuer!, value: "100000000" },
  }, trustCtx);
  await submitOrThrow(ctx.client, ctx.wallets.issuer, {
    TransactionType: "Payment",
    Account: ctx.wallets.issuer.address,
    Destination: wallet.address,
    Amount: { currency: asset.currency, issuer: asset.issuer!, value: distributeValue },
  }, { setupId: ctx.env.setupId, correlationId: "outsider-fund" });
  return wallet;
}

// Issue a credential of an arbitrary type to a subject and have them accept it — used to give an
// outsider the *wrong* credential type (accepted, but not the type the domain admits).
// The recognized credential issuer for a permissioned environment. Credential cases run only when a
// domain exists, so this is guaranteed present there; a missing one is a programming error.
export function credentialIssuerOf(ctx: CaseContext): Wallet {
  if (!ctx.wallets.credentialIssuer) throw new Error("credential case ran against an environment with no credential issuer");
  return ctx.wallets.credentialIssuer;
}

export async function issueCredential(ctx: CaseContext, subject: Wallet, credentialTypeHex: string): Promise<void> {
  const credentialIssuer = credentialIssuerOf(ctx);
  await submitOrThrow(ctx.client, credentialIssuer, {
    TransactionType: "CredentialCreate",
    Account: credentialIssuer.address,
    Subject: subject.address,
    CredentialType: credentialTypeHex,
  }, { setupId: ctx.env.setupId, correlationId: "wrong-cred-create" });
  await submitOrThrow(ctx.client, subject, {
    TransactionType: "CredentialAccept",
    Account: subject.address,
    Issuer: credentialIssuer.address,
    CredentialType: credentialTypeHex,
  }, { setupId: ctx.env.setupId, correlationId: "wrong-cred-accept" });
}

export interface LoanTerms {
  principal: string;
  interestRate: number;
  paymentInterval: number;
  gracePeriod: number;
}

// Originate a loan with a bilateral (dual-signed) LoanSet: the owner signs, the borrower
// counter-signs the same transaction. Returns the created loan's id. Used by the cases that need a
// live loan to act against.
export async function originateLoan(ctx: CaseContext, borrower: Wallet, terms: LoanTerms, correlation: string): Promise<string> {
  const corr = correlation;
  const loanSet = {
    TransactionType: "LoanSet" as const,
    Account: ctx.wallets.owner.address,
    LoanBrokerID: ctx.env.objects.brokerId!,
    Counterparty: borrower.address,
    PrincipalRequested: terms.principal,
    InterestRate: terms.interestRate,
    PaymentInterval: terms.paymentInterval,
    GracePeriod: terms.gracePeriod,
    LoanOriginationFee: "0",
    Memos: buildMemos(ctx.env.setupId, corr),
  };
  const prepared = await ctx.client.autofill(loanSet);
  const ownerSigned = ctx.wallets.owner.sign(prepared);
  const combined = signLoanSetByCounterparty(borrower, ownerSigned.tx_blob);
  const res = await ctx.client.submitAndWait(combined.tx_blob);
  const meta = res.result.meta;
  const code = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
  if (code !== "tesSUCCESS") throw new Error(`origination for ${corr} returned ${code}`);
  const loanId = await findLoanId(ctx, borrower.address);
  if (!loanId) throw new Error(`origination for ${corr} produced no loan object`);
  return loanId;
}

export async function findLoanId(ctx: CaseContext, borrower: string): Promise<string | undefined> {
  for (const account of [ctx.wallets.owner.address, borrower]) {
    const res = await ctx.client.request({ command: "account_objects", account, type: "loan", ledger_index: "validated" });
    const objs = res.result.account_objects as unknown as Record<string, unknown>[];
    if (objs[0]?.index) return objs[0].index as string;
  }
  return undefined;
}

export async function ensureDeposit(ctx: CaseContext, depositor: Wallet, value: string, correlation: string): Promise<void> {
  await submitOrThrow(ctx.client, depositor, {
    TransactionType: "VaultDeposit",
    Account: depositor.address,
    VaultID: ctx.env.objects.vaultId!,
    Amount: iouAmount(ctx, value),
  }, { setupId: ctx.env.setupId, correlationId: correlation });
}
