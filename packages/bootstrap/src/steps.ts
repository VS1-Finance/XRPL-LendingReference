import {
  type Config,
  type DerivedAccountSet,
  type SubmitContext,
  correlationId,
  isXrpAsset,
  submitOrThrow,
} from "@lending/shared";
import { VaultCreateFlags, VaultWithdrawalPolicy, xrpToDrops, type Client, type Currency, type Wallet } from "xrpl";
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

interface StepDeps {
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

// Run a single provisioning step. If `alreadyDone` resolves true the transaction is skipped and a
// skipped record is logged; otherwise the action runs and its result is recorded. Either way the
// step is reflected in the environment's step list, so a re-run produces the same shape.
async function step(
  deps: StepDeps,
  action: string,
  alreadyDone: () => Promise<boolean>,
  run: (ctx: SubmitContext) => Promise<{ result: string; txHash?: string }>,
): Promise<void> {
  const corr = correlationId(deps.setupId, action);
  if (await alreadyDone()) {
    deps.log(`${action} — already present, skip`);
    const skippedRecord: StepRecord = { action, correlationId: corr, result: "skipped", skipped: true };
    deps.env.steps.push(skippedRecord);
    deps.onStep?.(skippedRecord);
    return;
  }
  const ctx: SubmitContext = { setupId: deps.setupId, correlationId: corr };
  const { result, txHash } = await run(ctx);
  deps.log(`${action} — ${result}${txHash ? ` ${txHash.slice(0, 12)}…` : ""}`);
  const record: StepRecord = { action, correlationId: corr, result, skipped: false };
  if (txHash !== undefined) record.txHash = txHash;
  deps.env.steps.push(record);
  deps.onStep?.(record);
}

export async function configureIssuer(deps: StepDeps): Promise<void> {
  const issuer = deps.accounts.issuer.wallet;
  // Clawback must be enabled before any of the asset is issued, so this runs first.
  await step(
    deps,
    "issuer-allow-clawback",
    () => accountHasFlag(deps.client, issuer.address, LSF_ALLOW_CLAWBACK),
    async (ctx) => {
      const r = await submitOrThrow(deps.client, issuer, { TransactionType: "AccountSet", Account: issuer.address, SetFlag: ASF_ALLOW_CLAWBACK }, ctx);
      return { result: r.engineResult, txHash: r.hash };
    },
  );
  await step(
    deps,
    "issuer-default-ripple",
    () => accountHasFlag(deps.client, issuer.address, LSF_DEFAULT_RIPPLE),
    async (ctx) => {
      const r = await submitOrThrow(deps.client, issuer, { TransactionType: "AccountSet", Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }, ctx);
      return { result: r.engineResult, txHash: r.hash };
    },
  );
}

// Set a trust line for a holder and distribute the configured amount of the asset to it. Skipped
// for an XRP asset, which has no trust lines.
export async function distributeAsset(deps: StepDeps, holder: Wallet, role: string, amount: string): Promise<void> {
  if (isXrpAsset(deps.config.asset)) return;
  const issuer = deps.accounts.issuer.wallet;
  const currency = deps.config.asset.currency;

  await step(
    deps,
    `trust-${role}`,
    () => hasTrustLine(deps.client, holder.address, currency, issuer.address),
    async (ctx) => {
      const r = await submitOrThrow(
        deps.client,
        holder,
        { TransactionType: "TrustSet", Account: holder.address, LimitAmount: { currency, issuer: issuer.address, value: "100000000" } },
        ctx,
      );
      return { result: r.engineResult, txHash: r.hash };
    },
  );

  // Idempotent on balance: skip distribution only once the holder already holds the target amount,
  // so a re-run after a freshly created trust line still funds it, but a fully provisioned holder
  // is not topped up again.
  await step(
    deps,
    `distribute-${role}`,
    async () => {
      const balance = await issuedBalance(deps.client, holder.address, currency, issuer.address);
      return Number(balance) >= Number(amount);
    },
    async (ctx) => {
      const r = await submitOrThrow(
        deps.client,
        issuer,
        { TransactionType: "Payment", Account: issuer.address, Destination: holder.address, Amount: { currency, issuer: issuer.address, value: amount } },
        ctx,
      );
      return { result: r.engineResult, txHash: r.hash };
    },
  );
}

// The first accepted credential type from a permissioned config. These steps run only when a domain is
// configured, so a missing domain here is a programming error rather than a supported path.
function requireCredentialType(deps: StepDeps): string {
  const domain = deps.config.domain;
  if (!domain) throw new Error("credential/domain steps require a configured domain (permissioned vault)");
  return domain.acceptedCredentials[0]!.credentialType;
}

// The credential issuer's wallet. Credentials are issued by a separate account from the currency issuer,
// derived only for a permissioned session — so a missing one here is a programming error, same as above.
function requireCredentialIssuer(deps: StepDeps) {
  const credentialIssuer = deps.accounts.credentialIssuer;
  if (!credentialIssuer) throw new Error("credential/domain steps require a credential issuer (permissioned vault)");
  return credentialIssuer.wallet;
}

export async function issueCredentials(deps: StepDeps): Promise<void> {
  const issuer = requireCredentialIssuer(deps);
  const credType = requireCredentialType(deps);
  const credHex = encodeCredentialType(credType);
  const members = [...deps.accounts.depositors, ...deps.accounts.borrowers];

  for (const member of members) {
    const subj = member.wallet;
    const label = `${member.role}[${member.index}]`;
    await step(
      deps,
      `credential-create-${label}`,
      () => hasAcceptedCredential(deps.client, subj.address, issuer.address, credHex),
      async (ctx) => {
        const r = await submitOrThrow(deps.client, issuer, { TransactionType: "CredentialCreate", Account: issuer.address, Subject: subj.address, CredentialType: credHex }, ctx);
        return { result: r.engineResult, txHash: r.hash };
      },
    );
    await step(
      deps,
      `credential-accept-${label}`,
      () => hasAcceptedCredential(deps.client, subj.address, issuer.address, credHex),
      async (ctx) => {
        const r = await submitOrThrow(deps.client, subj, { TransactionType: "CredentialAccept", Account: subj.address, Issuer: issuer.address, CredentialType: credHex }, ctx);
        return { result: r.engineResult, txHash: r.hash };
      },
    );
  }
}

export async function createDomain(deps: StepDeps): Promise<void> {
  const owner = deps.accounts.owner.wallet;
  // The domain accepts credentials from the credential issuer (not the currency issuer), matching what
  // issueCredentials grants.
  const issuer = requireCredentialIssuer(deps);
  const credHex = encodeCredentialType(requireCredentialType(deps));

  await step(
    deps,
    "domain-create",
    async () => (await findDomainId(deps.client, owner.address)) !== undefined,
    async (ctx) => {
      const r = await submitOrThrow(
        deps.client,
        owner,
        { TransactionType: "PermissionedDomainSet", Account: owner.address, AcceptedCredentials: [{ Credential: { Issuer: issuer.address, CredentialType: credHex } }] },
        ctx,
      );
      return { result: r.engineResult, txHash: r.hash };
    },
  );
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

  await step(
    deps,
    "vault-create",
    async () => (await findVault(deps.client, owner.address)) !== undefined,
    async (ctx) => {
      // A domain-gated vault must be private and carry the DomainID; a public vault carries neither.
      // The withdrawal policy is the single value the ledger exposes today.
      const r = await submitOrThrow(
        deps.client,
        owner,
        {
          TransactionType: "VaultCreate",
          Account: owner.address,
          Asset: asset,
          ...(permissioned ? { DomainID: domainId, Flags: VaultCreateFlags.tfVaultPrivate } : {}),
          WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
        },
        ctx,
      );
      return { result: r.engineResult, txHash: r.hash };
    },
  );
  const vault = await findVault(deps.client, owner.address);
  deps.env.objects.vaultId = vault?.index;
  deps.env.objects.shareMptId = vault?.shareMptId;
}

export async function createBroker(deps: StepDeps): Promise<void> {
  const owner = deps.accounts.owner.wallet;
  const vaultId = deps.env.objects.vaultId;
  if (!vaultId) throw new Error("cannot create a broker before the vault exists");

  await step(
    deps,
    "broker-create",
    async () => (await findBrokerId(deps.client, owner.address)) !== undefined,
    async (ctx) => {
      // Cover rates are immutable once the broker exists, so they are set from config here.
      const r = await submitOrThrow(
        deps.client,
        owner,
        {
          TransactionType: "LoanBrokerSet",
          Account: owner.address,
          VaultID: vaultId,
          ManagementFeeRate: deps.config.managementFeeRate,
          // DebtMaximum is in the broker's asset units — drops for XRP, whole tokens otherwise.
          DebtMaximum: isXrpAsset(deps.config.asset) ? xrpToDrops(deps.config.debtMaximum) : deps.config.debtMaximum,
          CoverRateMinimum: deps.config.coverRateMinimum,
          CoverRateLiquidation: deps.config.coverRateLiquidation,
        },
        ctx,
      );
      return { result: r.engineResult, txHash: r.hash };
    },
  );
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
  await step(
    deps,
    "cover-deposit",
    async () => {
      const current = await findBrokerCover(deps.client, owner.address);
      if (current === undefined) return false;
      return Number(current) >= Number(requiredCover);
    },
    async (ctx) => {
      const r = await submitOrThrow(
        deps.client,
        owner,
        { TransactionType: "LoanBrokerCoverDeposit", Account: owner.address, LoanBrokerID: brokerId, Amount: amount },
        ctx,
      );
      return { result: r.engineResult, txHash: r.hash };
    },
  );
}
