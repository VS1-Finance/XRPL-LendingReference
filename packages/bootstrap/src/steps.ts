import {
  type Config,
  type DerivedAccountSet,
  correlationId,
  isXrpAsset,
  submitBatch,
  type BatchItem,
} from "@lending/shared";
import { VaultCreateFlags, VaultWithdrawalPolicy, xrpToDrops, type Client, type Currency, type Wallet, type SubmittableTransaction } from "xrpl";
import {
  accountHasFlag,
  encodeCredentialType,
  findBrokerCover,
  findBrokerId,
  findDomainId,
  findVault,
  hasAcceptedCredential,
  hasTrustLine,
  issuedBalance,
} from "./ledger-lookups.js";
import type { ProvisionedEnvironment, StepRecord } from "./types.js";

// asfAllowTrustLineClawback / asfDefaultRipple as AccountSet SetFlag values.
const ASF_DEFAULT_RIPPLE = 8;
const ASF_ALLOW_CLAWBACK = 16;
// The corresponding account-root flag bits, used to check whether the flag is already set.
const LSF_DEFAULT_RIPPLE = 0x00800000;
const LSF_ALLOW_CLAWBACK = 0x80000000;

export interface StepDeps {
  client: Client;
  config: Config;
  accounts: DerivedAccountSet;
  setupId: string;
  env: ProvisionedEnvironment;
  log: (msg: string) => void;
  // Optional progress sink: called with each step record as it settles, so provisioning can be
  // streamed to a caller in real time.
  onStep?: (record: StepRecord) => void;
}


export interface PlannedStep {
  action: string;
  alreadyDone: () => Promise<boolean>;
  build: () => { wallet: Wallet; tx: SubmittableTransaction };
}

// Run a set of independent steps as one batch: check which are already on-ledger (in parallel), record
// those as skipped, and batch-submit the rest. Preserves the same StepRecord bookkeeping and onStep/log
// stream as the serial step() path, so re-runs and the activity view are unchanged.
export async function runBatch(deps: StepDeps, steps: PlannedStep[]): Promise<void> {
  if (steps.length === 0) return;
  const done = await Promise.all(steps.map((s) => s.alreadyDone()));
  const toRun: { step: PlannedStep; item: BatchItem }[] = [];
  steps.forEach((s, i) => {
    const corr = correlationId(deps.setupId, s.action);
    if (done[i]) {
      deps.log(`${s.action} — already present, skip`);
      const record: StepRecord = { action: s.action, correlationId: corr, result: "skipped", skipped: true };
      deps.env.steps.push(record);
      deps.onStep?.(record);
    } else {
      const { wallet, tx } = s.build();
      toRun.push({ step: s, item: { wallet, tx, ctx: { setupId: deps.setupId, correlationId: corr } } });
    }
  });
  if (toRun.length === 0) return;
  const submitted = await submitBatch(deps.client, toRun.map((r) => r.item));
  toRun.forEach(({ step: s }, i) => {
    const r = submitted[i]!;
    deps.log(`${s.action} — ${r.engineResult}${r.hash ? ` ${r.hash.slice(0, 12)}…` : ""}`);
    const record: StepRecord = { action: s.action, correlationId: correlationId(deps.setupId, s.action), result: r.engineResult, skipped: false };
    if (r.hash !== undefined) record.txHash = r.hash;
    deps.env.steps.push(record);
    deps.onStep?.(record);
  });
}

// ── New builder functions (Task 4) ─────────────────────────────────────────────────────────────

export function issuerFlagSteps(deps: StepDeps): PlannedStep[] {
  const issuer = deps.accounts.issuer.wallet;
  return [
    {
      action: "issuer-allow-clawback",
      alreadyDone: () => accountHasFlag(deps.client, issuer.address, LSF_ALLOW_CLAWBACK),
      build: () => ({ wallet: issuer, tx: { TransactionType: "AccountSet", Account: issuer.address, SetFlag: ASF_ALLOW_CLAWBACK } }),
    },
    {
      action: "issuer-default-ripple",
      alreadyDone: () => accountHasFlag(deps.client, issuer.address, LSF_DEFAULT_RIPPLE),
      build: () => ({ wallet: issuer, tx: { TransactionType: "AccountSet", Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE } }),
    },
  ];
}

export function trustSteps(deps: StepDeps, holder: Wallet, role: string): PlannedStep[] {
  if (isXrpAsset(deps.config.asset)) return [];
  const issuer = deps.accounts.issuer.wallet;
  const currency = deps.config.asset.currency;
  return [{
    action: `trust-${role}`,
    alreadyDone: () => hasTrustLine(deps.client, holder.address, currency, issuer.address),
    build: () => ({ wallet: holder, tx: { TransactionType: "TrustSet", Account: holder.address, LimitAmount: { currency, issuer: issuer.address, value: "100000000" } } }),
  }];
}

export function distributeSteps(deps: StepDeps, holder: Wallet, role: string, amount: string): PlannedStep[] {
  if (isXrpAsset(deps.config.asset)) return [];
  const issuer = deps.accounts.issuer.wallet;
  const currency = deps.config.asset.currency;
  return [{
    action: `distribute-${role}`,
    alreadyDone: async () => Number(await issuedBalance(deps.client, holder.address, currency, issuer.address)) >= Number(amount),
    build: () => ({ wallet: issuer, tx: { TransactionType: "Payment", Account: issuer.address, Destination: holder.address, Amount: { currency, issuer: issuer.address, value: amount } } }),
  }];
}

// The first accepted credential type from a permissioned config. Missing domain is a programming error.
function requireCredentialType(deps: StepDeps): string {
  const domain = deps.config.domain;
  if (!domain) throw new Error("credential/domain steps require a configured domain (permissioned vault)");
  return domain.acceptedCredentials[0]!.credentialType;
}

// The credential issuer's wallet. Derived only for a permissioned session — missing one is a programming error.
function requireCredentialIssuer(deps: StepDeps) {
  const credentialIssuer = deps.accounts.credentialIssuer;
  if (!credentialIssuer) throw new Error("credential/domain steps require a credential issuer (permissioned vault)");
  return credentialIssuer.wallet;
}

export function credentialCreateSteps(deps: StepDeps): PlannedStep[] {
  const issuer = requireCredentialIssuer(deps);
  const credHex = encodeCredentialType(requireCredentialType(deps));
  return [...deps.accounts.depositors, ...deps.accounts.borrowers].map((member) => ({
    action: `credential-create-${member.role}[${member.index}]`,
    alreadyDone: () => hasAcceptedCredential(deps.client, member.wallet.address, issuer.address, credHex),
    build: () => ({ wallet: issuer, tx: { TransactionType: "CredentialCreate", Account: issuer.address, Subject: member.wallet.address, CredentialType: credHex } }),
  }));
}

export function credentialAcceptSteps(deps: StepDeps): PlannedStep[] {
  const issuer = requireCredentialIssuer(deps);
  const credHex = encodeCredentialType(requireCredentialType(deps));
  return [...deps.accounts.depositors, ...deps.accounts.borrowers].map((member) => ({
    action: `credential-accept-${member.role}[${member.index}]`,
    alreadyDone: () => hasAcceptedCredential(deps.client, member.wallet.address, issuer.address, credHex),
    build: () => ({ wallet: member.wallet, tx: { TransactionType: "CredentialAccept", Account: member.wallet.address, Issuer: issuer.address, CredentialType: credHex } }),
  }));
}

export async function createDomain(deps: StepDeps): Promise<void> {
  const owner = deps.accounts.owner.wallet;
  // The domain accepts credentials from the credential issuer (not the currency issuer), matching what
  // issueCredentials grants.
  const issuer = requireCredentialIssuer(deps);
  const credHex = encodeCredentialType(requireCredentialType(deps));

  await runBatch(deps, [{
    action: "domain-create",
    alreadyDone: async () => (await findDomainId(deps.client, owner.address)) !== undefined,
    build: () => ({ wallet: owner, tx: { TransactionType: "PermissionedDomainSet", Account: owner.address, AcceptedCredentials: [{ Credential: { Issuer: issuer.address, CredentialType: credHex } }] } }),
  }]);
  deps.env.objects.domainId = await findDomainId(deps.client, owner.address);
}

export async function createVault(deps: StepDeps): Promise<void> {
  const owner = deps.accounts.owner.wallet;
  // A permissioned vault has a domain (created just before this) and is private + domain-gated. A public
  // vault has no domain: it is created open, so anyone may deposit without a credential.
  const domainId = deps.env.objects.domainId;
  const permissioned = domainId !== undefined;

  const asset: Currency = isXrpAsset(deps.config.asset)
    ? { currency: "XRP" }
    : { currency: deps.config.asset.currency, issuer: deps.accounts.issuer.address };

  await runBatch(deps, [{
    action: "vault-create",
    alreadyDone: async () => (await findVault(deps.client, owner.address)) !== undefined,
    build: () => ({
      wallet: owner,
      tx: {
        TransactionType: "VaultCreate",
        Account: owner.address,
        Asset: asset,
        ...(permissioned ? { DomainID: domainId, Flags: VaultCreateFlags.tfVaultPrivate } : {}),
        WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
      },
    }),
  }]);
  const vault = await findVault(deps.client, owner.address);
  deps.env.objects.vaultId = vault?.index;
  deps.env.objects.shareMptId = vault?.shareMptId;
}

export async function createBroker(deps: StepDeps): Promise<void> {
  const owner = deps.accounts.owner.wallet;
  const vaultId = deps.env.objects.vaultId;
  if (!vaultId) throw new Error("cannot create a broker before the vault exists");

  await runBatch(deps, [{
    action: "broker-create",
    alreadyDone: async () => (await findBrokerId(deps.client, owner.address)) !== undefined,
    build: () => ({
      wallet: owner,
      tx: {
        TransactionType: "LoanBrokerSet",
        Account: owner.address,
        VaultID: vaultId,
        ManagementFeeRate: deps.config.managementFeeRate,
        // DebtMaximum is in the broker's asset units — drops for XRP, whole tokens otherwise.
        DebtMaximum: isXrpAsset(deps.config.asset) ? xrpToDrops(deps.config.debtMaximum) : deps.config.debtMaximum,
        CoverRateMinimum: deps.config.coverRateMinimum,
        CoverRateLiquidation: deps.config.coverRateLiquidation,
      },
    }),
  }]);
  deps.env.objects.brokerId = await findBrokerId(deps.client, owner.address);
}

export async function depositCover(deps: StepDeps): Promise<void> {
  const owner = deps.accounts.owner.wallet;
  const brokerId = deps.env.objects.brokerId;
  if (!brokerId) throw new Error("cannot deposit cover before the broker exists");

  // Cover is deposited in the broker's asset units: drops for XRP, an issued amount otherwise. The
  // configured coverAmount is a whole-token value, so XRP is converted to drops.
  const amount = isXrpAsset(deps.config.asset)
    ? xrpToDrops(deps.config.coverAmount)
    : { currency: deps.config.asset.currency, issuer: deps.accounts.issuer.address, value: deps.config.coverAmount };

  // Idempotent on the configured cover amount: a re-run that already holds at least that much
  // cover skips the deposit instead of stacking a second one. The on-ledger cover is in the broker's
  // asset units — drops for XRP — so the configured whole-token amount is converted to match before
  // comparing, otherwise an XRP broker's drops cover always dwarfs the whole-token threshold.
  const requiredCover = isXrpAsset(deps.config.asset) ? xrpToDrops(deps.config.coverAmount) : deps.config.coverAmount;
  await runBatch(deps, [{
    action: "cover-deposit",
    alreadyDone: async () => {
      const current = await findBrokerCover(deps.client, owner.address);
      if (current === undefined) return false;
      return Number(current) >= Number(requiredCover);
    },
    build: () => ({ wallet: owner, tx: { TransactionType: "LoanBrokerCoverDeposit", Account: owner.address, LoanBrokerID: brokerId, Amount: amount } }),
  }]);
}
