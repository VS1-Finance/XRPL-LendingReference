import { correlationId, submitOrThrow } from "@lending/shared";
import type { Client } from "xrpl";
import { assetAmount, shareBalance } from "./ledger.js";
import type { LifecycleStep, ProvisionedEnvironment } from "./types.js";
import type { ResolvedAccount } from "./environment.js";

export interface DepositResult {
  step: LifecycleStep;
  sharesMinted: string;
}

// The depositor deposits liquidity into the vault and receives shares. Asserts that shares were
// actually minted to the depositor, since the deposit is only meaningful if the holder's share
// balance grew.
export async function deposit(
  client: Client,
  env: ProvisionedEnvironment,
  depositor: ResolvedAccount,
  amount: string,
  seq: number,
): Promise<DepositResult> {
  const vaultId = env.objects.vaultId!;
  const shareMptId = env.objects.shareMptId!;
  const corr = correlationId(env.setupId, "deposit");

  const before = BigInt(await shareBalance(client, depositor.account.address, shareMptId));

  const r = await submitOrThrow(
    client,
    depositor.wallet,
    { TransactionType: "VaultDeposit", Account: depositor.account.address, VaultID: vaultId, Amount: assetAmount(env, amount) },
    { setupId: env.setupId, correlationId: corr },
  );

  const after = BigInt(await shareBalance(client, depositor.account.address, shareMptId));
  const minted = after - before;
  if (minted <= 0n) {
    throw new Error(`deposit of ${amount} minted no shares (before ${before}, after ${after})`);
  }

  return {
    sharesMinted: minted.toString(),
    step: { seq, action: "VaultDeposit", correlationId: corr, result: r.engineResult, txHash: r.hash, detail: { amount, shares: minted.toString() } },
  };
}
