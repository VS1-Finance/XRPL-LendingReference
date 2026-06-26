import { Wallet } from "xrpl";
import { submitOrThrow } from "@lending/shared";
import { submitExpectReject } from "../assert.js";
import { encodeCredentialType, fundOutsider, iouAmount, issueCredential } from "../helpers.js";
import type { NegativeCase } from "../types.js";

// N1–N5 guard the deposit-side domain gate: only accounts holding an accepted credential of the
// type the domain admits may deposit into the vault. Every rejection here is tecNO_AUTH.

// N1 — an account with no credential at all attempts to deposit.
const N1: NegativeCase = {
  id: "N1",
  title: "deposit with no accepted credential",
  guards: "deposit-side domain gate",
  expected: { kind: "reject", code: "tecNO_AUTH" },
  async run(ctx) {
    const outsider = await fundOutsider(ctx);
    return depositAttempt(ctx, outsider, "N1");
  },
};

// N2 — an account holding a credential of the wrong type (accepted, but not the admitted type).
const N2: NegativeCase = {
  id: "N2",
  title: "deposit with wrong credential type",
  guards: "deposit-side domain gate",
  expected: { kind: "reject", code: "tecNO_AUTH" },
  async run(ctx) {
    const outsider = await fundOutsider(ctx);
    await issueCredential(ctx, outsider, encodeCredentialType("WRONGTYPE"));
    return depositAttempt(ctx, outsider, "N2");
  },
};

// N3 — an account holding the right credential type but issued by an unrecognized issuer (a second
// issuer the domain does not list). The outsider self-issues via a fresh issuer account.
const N3: NegativeCase = {
  id: "N3",
  title: "deposit with credential from an unrecognized issuer",
  guards: "deposit-side domain gate",
  expected: { kind: "reject", code: "tecNO_AUTH" },
  async run(ctx) {
    const outsider = await fundOutsider(ctx);
    const rogueIssuer = (await ctx.client.fundWallet(null, { amount: "50" })).wallet;
    const credHex = encodeCredentialType(ctx.env.credentialType);
    await submitOrThrow(ctx.client, rogueIssuer, { TransactionType: "CredentialCreate", Account: rogueIssuer.address, Subject: outsider.address, CredentialType: credHex }, { setupId: ctx.env.setupId, correlationId: "N3-rogue-create" });
    await submitOrThrow(ctx.client, outsider, { TransactionType: "CredentialAccept", Account: outsider.address, Issuer: rogueIssuer.address, CredentialType: credHex }, { setupId: ctx.env.setupId, correlationId: "N3-rogue-accept" });
    return depositAttempt(ctx, outsider, "N3");
  },
};

// N4 — a legitimate member whose credential is revoked, then attempts to deposit. The revocation
// removes their domain membership, so the deposit is rejected the same way an outsider's is.
const N4: NegativeCase = {
  id: "N4",
  title: "deposit after credential revoked",
  guards: "deposit-side domain gate (revocation cascade)",
  expected: { kind: "reject", code: "tecNO_AUTH" },
  async run(ctx) {
    // A second depositor is provisioned for exactly this: revoke it without disturbing the primary.
    const member = ctx.wallets.depositors[1] ?? ctx.wallets.depositors[0]!;
    const credHex = encodeCredentialType(ctx.env.credentialType);
    await submitOrThrow(ctx.client, ctx.wallets.issuer, { TransactionType: "CredentialDelete", Account: ctx.wallets.issuer.address, Subject: member.address, CredentialType: credHex }, { setupId: ctx.env.setupId, correlationId: "N4-revoke" });
    return depositAttempt(ctx, member, "N4");
  },
};

// N5 — a vault share is transferred toward a non-member. Shares are share-MPTs whose movement is
// gated by domain membership, so the transfer to a non-credentialed account is rejected.
const N5: NegativeCase = {
  id: "N5",
  title: "share transfer to a non-member",
  guards: "share-movement domain gate",
  expected: { kind: "reject", code: "tecNO_AUTH" },
  async run(ctx) {
    const outsider = await fundOutsider(ctx);
    const depositor = ctx.wallets.depositors[0]!;
    return submitExpectReject(ctx, depositor, {
      TransactionType: "Payment",
      Account: depositor.address,
      Destination: outsider.address,
      Amount: { mpt_issuance_id: ctx.env.objects.shareMptId!, value: "1" },
    }, "N5-share-transfer");
  },
};

// The shared deposit attempt used by N1–N4: try to deposit the environment's asset into the vault.
async function depositAttempt(ctx: Parameters<NegativeCase["run"]>[0], actor: Wallet, correlation: string) {
  return submitExpectReject(ctx, actor, {
    TransactionType: "VaultDeposit",
    Account: actor.address,
    VaultID: ctx.env.objects.vaultId!,
    Amount: iouAmount(ctx, "1000"),
  }, `${correlation}-deposit`);
}

export const credentialCases: NegativeCase[] = [N1, N2, N3, N4, N5];
