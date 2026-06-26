import { Wallet } from "xrpl";
import { submitOrThrow, withRetry, type SubmitContext } from "@lending/shared";
import type { CaseContext } from "./types.js";

// A credential type is readable ASCII in config and hex on the ledger.
export function encodeCredentialType(type: string): string {
  return Buffer.from(type, "utf8").toString("hex").toUpperCase();
}

// The environment's asset as an Amount object (all negative-suite environments use an issued asset).
export function iouAmount(ctx: CaseContext, value: string): { currency: string; issuer: string; value: string } {
  const { currency, issuer } = ctx.env.asset;
  if (!issuer) throw new Error("negative-suite environments must use an issued asset with an issuer");
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
export async function issueCredential(ctx: CaseContext, subject: Wallet, credentialTypeHex: string): Promise<void> {
  await submitOrThrow(ctx.client, ctx.wallets.issuer, {
    TransactionType: "CredentialCreate",
    Account: ctx.wallets.issuer.address,
    Subject: subject.address,
    CredentialType: credentialTypeHex,
  }, { setupId: ctx.env.setupId, correlationId: "wrong-cred-create" });
  await submitOrThrow(ctx.client, subject, {
    TransactionType: "CredentialAccept",
    Account: subject.address,
    Issuer: ctx.wallets.issuer.address,
    CredentialType: credentialTypeHex,
  }, { setupId: ctx.env.setupId, correlationId: "wrong-cred-accept" });
}
