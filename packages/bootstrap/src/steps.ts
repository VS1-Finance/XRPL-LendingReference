import {
  type Config,
  type DerivedAccountSet,
  correlationId,
  decimalToScaled,
  isXrpAsset,
  isMptAsset,
  submitBatch,
  submitNativeBatch,
  type BatchItem,
  type BatchInner,
} from "@lending/shared";
import {
  MPTokenIssuanceCreateFlags,
  VaultCreateFlags,
  VaultWithdrawalPolicy,
  xrpToDrops,
  type Client,
  type Currency,
  type Wallet,
  type SubmittableTransaction,
} from "xrpl";
import {
  accountHasFlag,
  encodeCredentialType,
  findBrokerCover,
  findBrokerId,
  findDomainId,
  findMptIssuance,
  findVault,
  hasAcceptedCredential,
  hasMptAuthorization,
  hasTrustLine,
  issuedBalance,
  mptBalance,
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

export interface BatchUnit {
  key: string;
  // Skip this unit entirely when already satisfied on-ledger (idempotent re-run).
  alreadyDone: () => Promise<boolean>;
  // On-ledger source of truth after the Batch validates — the pair actually took effect.
  verify: () => Promise<boolean>;
  // The paired inner txns (e.g. create+accept, or trust+distribute), signed by their own accounts.
  inners: { action: string; build: () => { wallet: Wallet; tx: SubmittableTransaction } }[];
}

// Run cross-account pairs as atomic XLS-56 Batches. Each unit's inners either all apply or none do.
// Units already satisfied on-ledger are skipped (recorded as skipped, same as runBatch). Remaining
// units are chunked so no Batch exceeds 8 inner txns, submitted via submitNativeBatch, then each unit
// is re-checked on-ledger. Preserves the StepRecord/onStep/log bookkeeping and action names exactly.
export async function runCrossAccountBatches(deps: StepDeps, units: BatchUnit[]): Promise<void> {
  if (units.length === 0) return;

  const done = await Promise.all(units.map((u) => u.alreadyDone()));
  const todo: BatchUnit[] = [];
  units.forEach((u, i) => {
    if (done[i]) {
      for (const inner of u.inners) {
        const corr = correlationId(deps.setupId, inner.action);
        deps.log(`${inner.action} — already present, skip`);
        const record: StepRecord = { action: inner.action, correlationId: corr, result: "skipped", skipped: true };
        deps.env.steps.push(record);
        deps.onStep?.(record);
      }
    } else {
      todo.push(u);
    }
  });
  if (todo.length === 0) return;

  // Chunk units so total inners per Batch ≤ 8. Units here are pairs (2 inners) → ≤4 units per chunk,
  // but chunk by inner count to stay correct if a unit ever carries a different count.
  const chunks: BatchUnit[][] = [];
  let current: BatchUnit[] = [];
  let innerCount = 0;
  for (const u of todo) {
    if (innerCount + u.inners.length > 8) {
      chunks.push(current);
      current = [];
      innerCount = 0;
    }
    current.push(u);
    innerCount += u.inners.length;
  }
  if (current.length) chunks.push(current);

  for (const chunk of chunks) {
    const inners: BatchInner[] = chunk.flatMap((u) =>
      u.inners.map((inner) => {
        const { wallet, tx } = inner.build();
        return { wallet, tx, ctx: { setupId: deps.setupId, correlationId: correlationId(deps.setupId, inner.action) } };
      }),
    );
    const result = await submitNativeBatch(deps.client, inners);

    // The outer succeeded; confirm each unit actually took effect on-ledger. Record every unit that
    // verified true first, so a unit that landed keeps its audit trail even if a later unit in the
    // same chunk failed — only then throw for whichever units failed verification.
    const verified = await Promise.all(chunk.map((u) => u.verify()));
    const failed: BatchUnit[] = [];
    chunk.forEach((u, i) => {
      if (!verified[i]) {
        failed.push(u);
        return;
      }
      for (const inner of u.inners) {
        deps.log(`${inner.action} — ${result.engineResult} (batch ${result.hash.slice(0, 12)}…)`);
        const record: StepRecord = { action: inner.action, correlationId: correlationId(deps.setupId, inner.action), result: result.engineResult, skipped: false };
        record.txHash = result.hash;
        deps.env.steps.push(record);
        deps.onStep?.(record);
      }
    });
    if (failed.length > 0) {
      throw new Error(`cross-account batch unit(s) ${failed.map((u) => u.key).join(", ")} did not verify on-ledger after Batch ${result.hash.slice(0, 12)}…`);
    }
  }
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

// Still used by session/add-participant.ts to run trust and distribute as two separate steps at
// runtime (the new participant's own connection signs the TrustSet; the provisioning path above now
// uses the atomic trustAndDistributeUnits instead).
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
  if (isMptAsset(deps.config.asset)) return [];
  const issuer = deps.accounts.issuer.wallet;
  const currency = deps.config.asset.currency;
  return [{
    action: `distribute-${role}`,
    alreadyDone: async () => Number(await issuedBalance(deps.client, holder.address, currency, issuer.address)) >= Number(amount),
    build: () => ({ wallet: issuer, tx: { TransactionType: "Payment", Account: issuer.address, Destination: holder.address, Amount: { currency, issuer: issuer.address, value: amount } } }),
  }];
}

// MPT parallel to trustSteps, for session/add-participant.ts's two-separate-runBatch runtime pattern
// (as opposed to the atomic mptAuthorizeAndDistributeUnits pair used by provisioning). No-op for a
// non-MPT vault.
export function mptAuthorizeSteps(deps: StepDeps, holder: Wallet, role: string): PlannedStep[] {
  if (!isMptAsset(deps.config.asset)) return [];
  const mptIssuanceId = deps.env.objects.assetMptId;
  if (!mptIssuanceId) throw new Error("mptAuthorizeSteps requires the asset MPT issuance to already exist (env.objects.assetMptId)");
  return [{
    action: `mpt-authorize-${role}`,
    alreadyDone: () => hasMptAuthorization(deps.client, holder.address, mptIssuanceId),
    build: () => ({ wallet: holder, tx: { TransactionType: "MPTokenAuthorize", Account: holder.address, MPTokenIssuanceID: mptIssuanceId } }),
  }];
}

// MPT parallel to distributeSteps, for session/add-participant.ts's two-separate-runBatch runtime
// pattern. `amount` is a whole-token decimal string, scaled to the issuance's raw integer units before
// it is compared on-ledger or placed in the Payment. No-op for a non-MPT vault.
export function mptDistributeSteps(deps: StepDeps, holder: Wallet, role: string, amount: string): PlannedStep[] {
  if (!isMptAsset(deps.config.asset)) return [];
  const issuer = deps.accounts.issuer.wallet;
  const mptIssuanceId = deps.env.objects.assetMptId;
  if (!mptIssuanceId) throw new Error("mptDistributeSteps requires the asset MPT issuance to already exist (env.objects.assetMptId)");
  const scaledAmount = mptScaledAmount(deps.config, amount);
  return [{
    action: `distribute-${role}`,
    alreadyDone: async () => Number(await mptBalance(deps.client, holder.address, mptIssuanceId)) >= Number(scaledAmount),
    build: () => ({ wallet: issuer, tx: { TransactionType: "Payment", Account: issuer.address, Destination: holder.address, Amount: { mpt_issuance_id: mptIssuanceId, value: scaledAmount } } }),
  }];
}

// Per IOU holder (incl. owner): the TrustSet (holder) + distribute Payment (issuer) pair, as one atomic
// BatchUnit. Idempotent when the holder already holds at least the target amount (which implies the
// trust line exists). No-op for an XRP or MPT vault (MPT uses mptAuthorizeAndDistributeUnits instead).
export function trustAndDistributeUnits(
  deps: StepDeps,
  holders: { wallet: Wallet; label: string; amount: string }[],
): BatchUnit[] {
  if (isXrpAsset(deps.config.asset) || isMptAsset(deps.config.asset)) return [];
  const issuer = deps.accounts.issuer.wallet;
  const currency = deps.config.asset.currency;
  return holders.map(({ wallet, label, amount }) => {
    const holds = async () => Number(await issuedBalance(deps.client, wallet.address, currency, issuer.address)) >= Number(amount);
    return {
      key: `trust-distribute-${label}`,
      alreadyDone: holds,
      verify: holds,
      inners: [
        {
          action: `trust-${label}`,
          build: () => ({ wallet, tx: { TransactionType: "TrustSet", Account: wallet.address, LimitAmount: { currency, issuer: issuer.address, value: "100000000" } } }),
        },
        {
          action: `distribute-${label}`,
          build: () => ({ wallet: issuer, tx: { TransactionType: "Payment", Account: issuer.address, Destination: wallet.address, Amount: { currency, issuer: issuer.address, value: amount } } }),
        },
      ],
    };
  });
}

// The permissive flag set an MPT vault asset needs. A bare issuance (no flags) makes VaultCreate fail
// tecNO_AUTH — the vault needs to lock, escrow, trade, transfer, and clawback the asset it wraps, the
// same powers issuerFlagSteps grants an IOU issuer via AccountSet.
const MPT_ASSET_FLAGS =
  MPTokenIssuanceCreateFlags.tfMPTCanLock |
  MPTokenIssuanceCreateFlags.tfMPTCanEscrow |
  MPTokenIssuanceCreateFlags.tfMPTCanTrade |
  MPTokenIssuanceCreateFlags.tfMPTCanTransfer |
  MPTokenIssuanceCreateFlags.tfMPTCanClawback;

// Decimal places the vault-asset MPT issuance is created at (matches AssetScale on
// MPTokenIssuanceCreate below). MPT ledger amounts are raw integers at this scale — unlike an IOU's
// decimal `value` string — so every whole-token config amount (coverAmount, debtMaximum, …) is scaled
// through this before it appears in a transaction. 2 is the harness default, used whenever the config's
// MPT asset omits an explicit assetScale — this preserves today's behavior exactly for every session
// that doesn't opt into a non-default scale.
export const MPT_ASSET_SCALE = 2;

// The effective AssetScale for the current config's MPT asset: the configured value if the caller
// supplied one, else the MPT_ASSET_SCALE default. Guards non-MPT configs (asset.assetScale only exists
// on the MPT branch of AssetConfig) by falling back to the default rather than throwing, so callers that
// build amounts generically don't need their own MPT type guard first.
export function mptScale(config: Config): number {
  return (isMptAsset(config.asset) ? config.asset.assetScale : undefined) ?? MPT_ASSET_SCALE;
}

// Convert a whole-token decimal config value (e.g. coverAmount, debtMaximum) to the raw integer string
// an MPT amount field expects, at the config's effective MPT scale (mptScale).
export function mptScaledAmount(config: Config, value: string): string {
  return decimalToScaled(value, mptScale(config)).toString();
}

// The vault asset's MPTokenIssuanceID, captured on the env by provision.ts right after
// mptIssuanceSteps settles. Missing here is a programming error — createVault must run after it.
function requireAssetMptId(deps: StepDeps): string {
  const id = deps.env.objects.assetMptId;
  if (!id) throw new Error("MPT vault creation requires the asset MPT issuance to already exist (env.objects.assetMptId)");
  return id;
}

// The MaximumAmount to size the vault-asset issuance at, in raw integer units at the config's effective
// MPT scale (mptScale): enough to cover the owner's seeded cover (2x coverAmount, mirroring
// coverAndLiquidity in provision.ts) plus every depositor's and borrower's liquidity (debtMaximum each,
// mirroring liquidityPerHolder), with a 10x headroom multiple so bot activity and re-runs never bump the
// ceiling. Kept in integer (bigint) arithmetic throughout, consistent with money.ts conventions.
function mptMaximumAmount(deps: StepDeps): string {
  const scale = mptScale(deps.config);
  const cover = decimalToScaled(deps.config.coverAmount, scale) * 2n;
  const holders = BigInt(deps.config.pool.depositors + deps.config.pool.borrowers);
  const liquidity = decimalToScaled(deps.config.debtMaximum, scale) * holders;
  const headroom = 10n;
  return ((cover + liquidity) * headroom).toString();
}

// Parallel to issuerFlagSteps for the MPT path: one PlannedStep that creates the vault ASSET's MPT
// issuance (not the vault's own share MPT, which VaultCreate mints separately). Idempotent — a
// re-run finds the issuer's existing mpt_issuance object and skips. The resulting
// MPTokenIssuanceID is not known until the create settles, so it is not captured here: provision.ts
// reads it back via findMptIssuance immediately after running this step.
export function mptIssuanceSteps(deps: StepDeps): PlannedStep[] {
  const issuer = deps.accounts.issuer.wallet;
  return [
    {
      action: "mpt-asset-issuance-create",
      alreadyDone: async () => (await findMptIssuance(deps.client, issuer.address)) !== undefined,
      build: () => ({
        wallet: issuer,
        tx: {
          TransactionType: "MPTokenIssuanceCreate",
          Account: issuer.address,
          AssetScale: mptScale(deps.config),
          MaximumAmount: mptMaximumAmount(deps),
          Flags: MPT_ASSET_FLAGS,
        },
      }),
    },
  ];
}

// Per MPT holder (incl. owner): the MPTokenAuthorize (holder) + distribute Payment (issuer) pair, as
// one atomic BatchUnit — the MPT parallel to trustAndDistributeUnits. MPTokenAuthorize is the holder
// opting in to hold the issuance (no Holder field: the signing account IS the holder), which is what a
// TrustSet is for an IOU. Idempotent when the holder's MPT balance already meets the target (which
// implies authorization already happened). No-op for a non-MPT vault. `amount` is a whole-token
// decimal string (same convention as trustAndDistributeUnits); it is scaled to the issuance's raw
// integer units before it is compared on-ledger or placed in the Payment.
export function mptAuthorizeAndDistributeUnits(
  deps: StepDeps,
  holders: { wallet: Wallet; label: string; amount: string }[],
): BatchUnit[] {
  if (!isMptAsset(deps.config.asset)) return [];
  const issuer = deps.accounts.issuer.wallet;
  const mptIssuanceId = deps.env.objects.assetMptId;
  if (!mptIssuanceId) throw new Error("mptAuthorizeAndDistributeUnits requires the asset MPT issuance to already exist (env.objects.assetMptId)");
  return holders.map(({ wallet, label, amount }) => {
    const scaledAmount = mptScaledAmount(deps.config, amount);
    const holds = async () => Number(await mptBalance(deps.client, wallet.address, mptIssuanceId)) >= Number(scaledAmount);
    return {
      key: `mpt-authorize-distribute-${label}`,
      alreadyDone: holds,
      verify: holds,
      inners: [
        {
          action: `mpt-authorize-${label}`,
          build: () => ({ wallet, tx: { TransactionType: "MPTokenAuthorize", Account: wallet.address, MPTokenIssuanceID: mptIssuanceId } }),
        },
        {
          action: `distribute-${label}`,
          build: () => ({ wallet: issuer, tx: { TransactionType: "Payment", Account: issuer.address, Destination: wallet.address, Amount: { mpt_issuance_id: mptIssuanceId, value: scaledAmount } } }),
        },
      ],
    };
  });
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

// Per credentialed holder: the CredentialCreate (credential issuer) + CredentialAccept (holder) pair,
// as one atomic BatchUnit. Idempotent on an already-accepted credential.
export function credentialHandshakeUnits(deps: StepDeps): BatchUnit[] {
  const issuer = requireCredentialIssuer(deps);
  const credHex = encodeCredentialType(requireCredentialType(deps));
  return [...deps.accounts.depositors, ...deps.accounts.borrowers].map((member) => {
    const accepted = () => hasAcceptedCredential(deps.client, member.wallet.address, issuer.address, credHex);
    return {
      key: `credential-${member.role}[${member.index}]`,
      alreadyDone: accepted,
      verify: accepted,
      inners: [
        {
          action: `credential-create-${member.role}[${member.index}]`,
          build: () => ({ wallet: issuer, tx: { TransactionType: "CredentialCreate", Account: issuer.address, Subject: member.wallet.address, CredentialType: credHex } }),
        },
        {
          action: `credential-accept-${member.role}[${member.index}]`,
          build: () => ({ wallet: member.wallet, tx: { TransactionType: "CredentialAccept", Account: member.wallet.address, Issuer: issuer.address, CredentialType: credHex } }),
        },
      ],
    };
  });
}

// Still used by session/add-participant.ts to run create and accept as two separate steps at runtime
// (the new participant's own connection signs the accept; the provisioning path above now uses the
// atomic credentialHandshakeUnits instead).
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
    : isMptAsset(deps.config.asset)
      ? { mpt_issuance_id: requireAssetMptId(deps) }
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
        // DebtMaximum is in the broker's asset units: drops for XRP, the issuance's raw integer units
        // (at the config's effective mptScale) for MPT, whole tokens otherwise (IOU).
        DebtMaximum: isXrpAsset(deps.config.asset)
          ? xrpToDrops(deps.config.debtMaximum)
          : isMptAsset(deps.config.asset)
            ? mptScaledAmount(deps.config, deps.config.debtMaximum)
            : deps.config.debtMaximum,
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

  // Cover is deposited in the broker's asset units: drops for XRP, the issuance's raw integer units
  // (at the config's effective mptScale) for MPT, an issued amount otherwise (IOU). The configured
  // coverAmount is always a whole-token value, converted to match.
  const amount = isXrpAsset(deps.config.asset)
    ? xrpToDrops(deps.config.coverAmount)
    : isMptAsset(deps.config.asset)
      ? { mpt_issuance_id: requireAssetMptId(deps), value: mptScaledAmount(deps.config, deps.config.coverAmount) }
      : { currency: deps.config.asset.currency, issuer: deps.accounts.issuer.address, value: deps.config.coverAmount };

  // Idempotent on the configured cover amount: a re-run that already holds at least that much
  // cover skips the deposit instead of stacking a second one. The on-ledger cover is in the broker's
  // asset units — drops for XRP, raw integer units for MPT — so the configured whole-token amount is
  // converted to match before comparing, otherwise the threshold comparison is off by the scale factor.
  const requiredCover = isXrpAsset(deps.config.asset)
    ? xrpToDrops(deps.config.coverAmount)
    : isMptAsset(deps.config.asset)
      ? mptScaledAmount(deps.config, deps.config.coverAmount)
      : deps.config.coverAmount;
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
