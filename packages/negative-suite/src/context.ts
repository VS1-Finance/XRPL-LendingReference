import { deriveAccount, type Role } from "@lending/shared";
import type { Wallet } from "xrpl";
import type { ProvisionedEnvironment } from "@lending/bootstrap";

// The signing wallets for a provisioned environment's accounts, re-derived from the seed. The
// provisioned graph stores only addresses, so the same seed must be supplied to act as them.
export interface ResolvedWallets {
  issuer: Wallet;
  owner: Wallet;
  depositors: Wallet[];
  borrowers: Wallet[];
}

export function resolveWallets(env: ProvisionedEnvironment, seed: string): ResolvedWallets {
  const one = (role: Role, index: number, expected: string): Wallet => {
    const derived = deriveAccount(seed, role, index);
    if (derived.address !== expected) {
      throw new Error(`seed does not match environment: ${role}[${index}] derives ${derived.address}, expected ${expected}`);
    }
    return derived.wallet;
  };

  return {
    issuer: one("issuer", 0, env.accounts.issuer.address),
    owner: one("owner", 0, env.accounts.owner.address),
    depositors: env.accounts.depositors.map((a) => one("depositor", a.index, a.address)),
    borrowers: env.accounts.borrowers.map((a) => one("borrower", a.index, a.address)),
  };
}
