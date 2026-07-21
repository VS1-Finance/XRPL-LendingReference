import type { Role } from "@lending/shared";

// A record of one transaction the harness submitted, kept so a re-run and an off-chain reader can
// both trace what happened. Steps skipped because the object already existed are marked skipped.
export interface StepRecord {
  action: string;
  correlationId: string;
  result: string;
  txHash?: string;
  skipped: boolean;
}

export interface ProvisionedAccount {
  role: Role;
  index: number;
  address: string;
}

// The wired object graph, keyed by setup id. Emitted to disk and consumed by downstream tooling.
export interface ProvisionedEnvironment {
  setupId: string;
  network: string;
  createdAt: string;
  asset: { currency: string; issuer?: string };
  // The credential type accounts are credentialed with, kept so teardown can remove them. Absent for a
  // public (non-permissioned) vault, which has no domain, no credentials, and no credential type.
  credentialType?: string;
  accounts: {
    issuer: ProvisionedAccount;
    // Present only for a permissioned session — the credential issuer, kept distinct from the currency
    // issuer so the raw ledger is legible. Absent for a public session.
    credentialIssuer?: ProvisionedAccount;
    owner: ProvisionedAccount;
    depositors: ProvisionedAccount[];
    borrowers: ProvisionedAccount[];
  };
  objects: {
    domainId?: string;
    vaultId?: string;
    shareMptId?: string;
    brokerId?: string;
  };
  steps: StepRecord[];
}
