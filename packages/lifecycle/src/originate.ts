import { correlationId, buildMemos } from "@lending/shared";
import { signLoanSetByCounterparty, type Client } from "xrpl";
import { brokerValue, findLoanId, issuedAssetBalance } from "./ledger.js";
import type { LifecycleStep, ProvisionedEnvironment } from "./types.js";
import type { ResolvedAccount } from "./environment.js";

export interface LoanTerms {
  principal: string;
  interestRate: number;
  paymentInterval: number;
  gracePeriod: number;
}

export interface OriginateResult {
  step: LifecycleStep;
  loanId: string;
}

// Origination is bilateral: the owner (broker) signs the LoanSet first, the borrower counter-signs
// the same transaction, and the combined blob is submitted. A single-signed LoanSet is rejected,
// so the counterparty-signing helper is used rather than hand-rolling the signature.
//
// Principal is delivered to the borrower inside the LoanSet itself — there is no separate draw —
// so origination is followed by an assertion that the borrower's asset balance grew by the
// principal.
export async function originate(
  client: Client,
  env: ProvisionedEnvironment,
  owner: ResolvedAccount,
  borrower: ResolvedAccount,
  terms: LoanTerms,
  seq: number,
): Promise<OriginateResult> {
  const corr = correlationId(env.setupId, "originate");
  const brokerId = env.objects.brokerId!;

  const before = Number(await issuedAssetBalance(client, borrower.account.address, env));

  // PrincipalRequested and the fee fields are scalar values in the vault asset's own units (the
  // asset is implied by the broker's vault), not Amount objects — drops for XRP, whole tokens otherwise.
  const loanSet = {
    TransactionType: "LoanSet" as const,
    Account: owner.account.address,
    LoanBrokerID: brokerId,
    Counterparty: borrower.account.address,
    PrincipalRequested: brokerValue(env, terms.principal),
    InterestRate: terms.interestRate,
    PaymentInterval: terms.paymentInterval,
    GracePeriod: terms.gracePeriod,
    LoanOriginationFee: "0",
    Memos: buildMemos(env.setupId, corr),
  };

  const prepared = await client.autofill(loanSet);
  const ownerSigned = owner.wallet.sign(prepared);
  const combined = signLoanSetByCounterparty(borrower.wallet, ownerSigned.tx_blob);
  const res = await client.submitAndWait(combined.tx_blob);

  const meta = res.result.meta;
  const engineResult = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
  if (engineResult !== "tesSUCCESS") {
    throw new Error(`bilateral LoanSet returned ${engineResult}`);
  }

  const loanId = await findLoanId(client, owner.account.address, borrower.account.address);
  if (!loanId) throw new Error("LoanSet succeeded but no loan object was found");

  const after = Number(await issuedAssetBalance(client, borrower.account.address, env));
  if (env.asset.currency !== "XRP" && after <= before) {
    throw new Error(`principal was not delivered inside LoanSet (borrower balance ${before} -> ${after})`);
  }

  return {
    loanId,
    step: {
      seq,
      action: "LoanSet",
      correlationId: corr,
      result: engineResult,
      txHash: res.result.hash,
      detail: { signers: ["owner", "borrower"], principal: terms.principal },
    },
  };
}
