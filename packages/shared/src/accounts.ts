import { createHash } from "node:crypto";
import { Wallet } from "xrpl";

// The fixed roles in a provisioned environment. The issuer mints the asset; the owner owns both
// the vault and the broker; depositors supply liquidity; borrowers take loans. Depositor and
// borrower are pooled, so they carry an index.
export type Role = "issuer" | "owner" | "depositor" | "borrower";

export interface DerivedAccount {
  role: Role;
  index: number;
  wallet: Wallet;
  address: string;
}

// Derive a wallet deterministically from (seed, role, index). The same inputs always produce the
// same account, so a re-run reuses addresses rather than funding fresh ones each time.
//
// Entropy is the first 16 bytes of SHA-256 over a domain-separated label. The label includes a
// fixed prefix so these accounts can't collide with hashes computed for any other purpose.
export function deriveAccount(seed: string, role: Role, index = 0): DerivedAccount {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`account index must be a non-negative integer, got ${index}`);
  }
  const label = `xrpl-lending/account/v1\0${seed}\0${role}\0${index}`;
  const entropy = createHash("sha256").update(label).digest().subarray(0, 16);
  const wallet = Wallet.fromEntropy(Array.from(entropy));
  return { role, index, wallet, address: wallet.classicAddress };
}

export interface DerivedAccountSet {
  issuer: DerivedAccount;
  owner: DerivedAccount;
  depositors: DerivedAccount[];
  borrowers: DerivedAccount[];
}

// Derive the full set of accounts for a pool of the given size. The issuer and owner are always
// index 0; depositors and borrowers are indexed 0..n-1.
export function deriveAccountSet(
  seed: string,
  pool: { depositors: number; borrowers: number },
): DerivedAccountSet {
  if (pool.depositors < 1 || pool.borrowers < 1) {
    throw new Error("pool must have at least one depositor and one borrower");
  }
  return {
    issuer: deriveAccount(seed, "issuer", 0),
    owner: deriveAccount(seed, "owner", 0),
    depositors: range(pool.depositors).map((i) => deriveAccount(seed, "depositor", i)),
    borrowers: range(pool.borrowers).map((i) => deriveAccount(seed, "borrower", i)),
  };
}

// Every account in a set, in a stable order: issuer, owner, then depositors and borrowers.
export function allAccounts(set: DerivedAccountSet): DerivedAccount[] {
  return [set.issuer, set.owner, ...set.depositors, ...set.borrowers];
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
