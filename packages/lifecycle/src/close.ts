import { correlationId, submitOrThrow } from "@lending/shared";
import type { Client } from "xrpl";
import { readLoan } from "./ledger.js";
import type { LifecycleStep, ProvisionedEnvironment } from "./types.js";
import type { ResolvedAccount } from "./environment.js";

export interface CloseResult {
  step?: LifecycleStep;
  closed: boolean;
}

// Close a repaid loan. If full repayment already removed the loan object the close is a no-op and
// the loan is reported closed; otherwise the owner issues LoanDelete to remove it.
export async function close(
  client: Client,
  env: ProvisionedEnvironment,
  owner: ResolvedAccount,
  loanId: string,
  seq: number,
): Promise<CloseResult> {
  const existing = await readLoan(client, loanId);
  if (!existing) return { closed: true };

  const corr = correlationId(env.setupId, "close");
  const r = await submitOrThrow(
    client,
    owner.wallet,
    { TransactionType: "LoanDelete", Account: owner.account.address, LoanID: loanId },
    { setupId: env.setupId, correlationId: corr },
  );

  const after = await readLoan(client, loanId);
  return {
    closed: after === undefined,
    step: { seq, action: "LoanDelete", correlationId: corr, result: r.engineResult, txHash: r.hash },
  };
}

// Read the vault's total assets, which grows by earned interest as loans are repaid. The depositor
// holds a fixed number of shares, so a rise in total assets is the depositor's earned yield made
// observable on-chain rather than computed off a float.
export async function readVaultAssets(client: Client, owner: string): Promise<string | undefined> {
  const res = await client.request({ command: "account_objects", account: owner, type: "vault", ledger_index: "validated" });
  const objs = res.result.account_objects as unknown as Record<string, unknown>[];
  const vault = objs[0];
  if (!vault) return undefined;
  const total = vault.AssetsTotal;
  if (typeof total === "string") return total;
  if (total && typeof total === "object" && "value" in total) return String((total as { value: unknown }).value);
  return undefined;
}
