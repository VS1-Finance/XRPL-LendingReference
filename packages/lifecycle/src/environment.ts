import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveAccount, type Role } from "@lending/shared";
import type { Wallet } from "xrpl";
import type { ProvisionedAccount, ProvisionedEnvironment } from "./types.js";

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentError";
  }
}

// An account with its reconstructed signing wallet. The provisioned graph stores only addresses;
// the wallets are re-derived from the seed, which is why the same seed must be supplied.
export interface ResolvedAccount {
  account: ProvisionedAccount;
  wallet: Wallet;
}

export interface ResolvedEnvironment {
  env: ProvisionedEnvironment;
  issuer: ResolvedAccount;
  owner: ResolvedAccount;
  depositors: ResolvedAccount[];
  borrowers: ResolvedAccount[];
}

// Read and validate a provisioned environment file.
export function loadProvisioned(path: string): ProvisionedEnvironment {
  const abs = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new EnvironmentError(`cannot read provisioned file ${abs}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return assertShape(parsed, abs);
}

// Re-derive every wallet from the seed and confirm the addresses match the provisioned graph. A
// mismatch means the seed does not belong to this environment, which is failed fast here rather
// than producing confusing rejections mid-run.
export function resolveEnvironment(env: ProvisionedEnvironment, seed: string): ResolvedEnvironment {
  const resolve1 = (a: ProvisionedAccount): ResolvedAccount => {
    const derived = deriveAccount(seed, a.role as Role, a.index);
    if (derived.address !== a.address) {
      throw new EnvironmentError(
        `seed does not match this environment: ${a.role}[${a.index}] derives ${derived.address}, expected ${a.address}`,
      );
    }
    return { account: a, wallet: derived.wallet };
  };

  return {
    env,
    issuer: resolve1(env.accounts.issuer),
    owner: resolve1(env.accounts.owner),
    depositors: env.accounts.depositors.map(resolve1),
    borrowers: env.accounts.borrowers.map(resolve1),
  };
}

function assertShape(value: unknown, path: string): ProvisionedEnvironment {
  const env = value as ProvisionedEnvironment;
  const missing: string[] = [];
  if (!env || typeof env !== "object") throw new EnvironmentError(`provisioned file ${path} is not an object`);
  if (!env.setupId) missing.push("setupId");
  if (!env.accounts?.owner?.address) missing.push("accounts.owner");
  if (!env.accounts?.depositors?.length) missing.push("accounts.depositors");
  if (!env.accounts?.borrowers?.length) missing.push("accounts.borrowers");
  if (!env.objects?.vaultId) missing.push("objects.vaultId");
  if (!env.objects?.brokerId) missing.push("objects.brokerId");
  if (!env.objects?.shareMptId) missing.push("objects.shareMptId");
  if (missing.length) {
    throw new EnvironmentError(`provisioned file ${path} is missing required fields: ${missing.join(", ")}`);
  }
  return env;
}
