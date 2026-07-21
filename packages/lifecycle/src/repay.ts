import { correlationId, sleep, submitOrThrow } from "@lending/shared";
import type { Client } from "xrpl";
import { assetAmount, ledgerToWhole, readLoan } from "./ledger.js";
import type { LifecycleStep, ProvisionedEnvironment } from "./types.js";
import type { ResolvedAccount } from "./environment.js";

export interface RepayResult {
  steps: LifecycleStep[];
  reachedRepaid: boolean;
}

// Drive repayment installment by installment until the loan is fully repaid. Each interval the
// borrower pays the scheduled periodic payment; the final payment settles the loan and the ledger
// removes the loan object. Amounts come from the live loan object and are clamped to the asset's
// precision before paying so a derived payment never lands short.
//
// A full-payment flag is intentionally not used: on the current ledger build a plain payment of
// the outstanding amount settles and closes the loan, which keeps the path uniform across the
// single- and multi-installment cases.
export async function repay(
  client: Client,
  env: ProvisionedEnvironment,
  borrower: ResolvedAccount,
  loanId: string,
  startSeq: number,
  options: { intervalSeconds: number; maxInstallments?: number } = { intervalSeconds: 60 },
): Promise<RepayResult> {
  const steps: LifecycleStep[] = [];
  const maxInstallments = options.maxInstallments ?? 24;
  let installment = 0;
  let seq = startSeq;

  while (installment < maxInstallments) {
    const loan = await readLoan(client, loanId);
    if (!loan) {
      // The loan object is gone — the previous payment settled and closed it.
      return { steps, reachedRepaid: true };
    }

    const remaining = Number(loan.PaymentRemaining ?? 0);
    if (remaining <= 0) return { steps, reachedRepaid: true };

    // On the last installment pay the whole outstanding balance; otherwise the periodic payment. Both
    // are read in ledger units (drops for XRP), so they are normalised to whole tokens before assetAmount.
    const ledgerDue = remaining <= 1 ? String(loan.TotalValueOutstanding) : String(loan.PeriodicPayment);
    const due = ledgerToWhole(env, ledgerDue);
    installment++;
    const corr = correlationId(env.setupId, `repay-${installment}`);

    const r = await submitOrThrow(
      client,
      borrower.wallet,
      { TransactionType: "LoanPay", Account: borrower.account.address, LoanID: loanId, Amount: assetAmount(env, due) },
      { setupId: env.setupId, correlationId: corr },
    );
    steps.push({ seq: seq++, action: "LoanPay", correlationId: corr, result: r.engineResult, txHash: r.hash, detail: { installment, amount: due } });

    const after = await readLoan(client, loanId);
    if (!after || Number(after.PaymentRemaining ?? 0) <= 0) {
      return { steps, reachedRepaid: true };
    }

    // Wait out the payment interval before the next installment.
    await sleep(options.intervalSeconds * 1000);
  }

  return { steps, reachedRepaid: false };
}
