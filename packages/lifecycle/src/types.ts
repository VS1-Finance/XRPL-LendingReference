// The shape of the environment graph emitted by the bootstrap harness, as read back here. Only
// the fields the lifecycle needs are described; unknown fields are ignored.
export interface ProvisionedEnvironment {
  setupId: string;
  network: "devnet" | "wasm-devnet";
  asset: { currency: string; issuer?: string };
  accounts: {
    issuer: ProvisionedAccount;
    owner: ProvisionedAccount;
    depositors: ProvisionedAccount[];
    borrowers: ProvisionedAccount[];
  };
  objects: {
    domainId?: string;
    vaultId?: string;
    shareMptId?: string;
    brokerId?: string;
    // The MPTokenIssuanceID of the vault ASSET for an MPT vault (distinct from shareMptId, which is
    // the vault's own share issuance). Absent for an XRP or IOU vault. Mirrors
    // bootstrap/src/types.ts's ProvisionedEnvironment.objects.assetMptId.
    assetMptId?: string;
  };
}

export interface ProvisionedAccount {
  role: "issuer" | "owner" | "depositor" | "borrower";
  index: number;
  address: string;
}

// One recorded step of a lifecycle run: an ordered, correlation-tagged action with its result.
export interface LifecycleStep {
  seq: number;
  action: string;
  correlationId: string;
  result: string;
  txHash?: string;
  // Action-specific detail, e.g. minted shares, principal, installment number.
  detail?: Record<string, string | number | string[]>;
}

export interface LifecycleRun {
  setupId: string;
  network: string;
  loanId?: string;
  reachedRepaid: boolean;
  closed: boolean;
  steps: LifecycleStep[];
}
