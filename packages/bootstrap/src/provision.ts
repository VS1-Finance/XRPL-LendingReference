import {
  type Config,
  type DerivedAccount,
  connect,
  deriveAccountSet,
  allAccounts,
  fanOutFunding,
  fundTreasuryForTargets,
  generateSetupId,
  isXrpAsset,
} from "@lending/shared";
import { assertCoverMeetsMinimum, assertSingleOwner } from "./assertions.js";
import {
  configureIssuer,
  createBroker,
  createDomain,
  createVault,
  depositCover,
  distributeAsset,
  issueCredentials,
} from "./steps.js";
import { saveEnvironment } from "./store.js";
import type { ProvisionedAccount, ProvisionedEnvironment, StepRecord } from "./types.js";

export interface ProvisionOptions {
  outDir?: string;
  log?: (msg: string) => void;
  // Called as each provisioning step settles (or is skipped), so a caller can stream progress —
  // action, result, and transaction hash — while provisioning runs rather than only at the end.
  onStep?: (record: StepRecord) => void;
  // A pre-supplied timestamp keeps the output reproducible in tests; defaults to now.
  now?: () => string;
}

// Stand up a fully wired environment from config and persist it. Idempotent: re-running with the
// same seed and setup id reuses accounts and skips objects that already exist.
export async function provision(config: Config, options: ProvisionOptions = {}): Promise<ProvisionedEnvironment> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date().toISOString());
  const setupId = config.setupId ?? generateSetupId();

  const accounts = deriveAccountSet(config.seed, config.pool);
  const env: ProvisionedEnvironment = {
    setupId,
    network: config.network,
    createdAt: now(),
    asset: isXrpAsset(config.asset)
      ? { currency: "XRP" }
      : { currency: config.asset.currency, issuer: accounts.issuer.address },
    // A permissioned vault carries a domain and a credential type; a public vault has neither.
    ...(config.domain ? { credentialType: config.domain.acceptedCredentials[0]!.credentialType } : {}),
    accounts: {
      issuer: toRecord(accounts.issuer),
      owner: toRecord(accounts.owner),
      depositors: accounts.depositors.map(toRecord),
      borrowers: accounts.borrowers.map(toRecord),
    },
    objects: {},
    steps: [],
  };

  const client = await connect(config.network);
  try {
    log(`provisioning ${setupId} on ${config.network}`);

    // Fund every derived account by fanning XRP out from a treasury sized to the whole pool. For an
    // IOU asset every account gets the flat funding amount (liquidity is minted separately). For an
    // XRP asset there is no minting — each holder must hold the XRP it will deposit — so the funding
    // is sized per role to include that liquidity.
    const everyAccount = allAccounts(accounts);
    const xrpForAccount = fundingPlan(config);
    const totalXrp = everyAccount.reduce((sum, a) => sum + xrpForAccount(a), 0);
    const treasury = await fundTreasuryForTargets(client, everyAccount.length, totalXrp, log);
    await fanOutFunding(client, treasury, everyAccount, {
      xrpPerAccount: config.fundingXrpPerAccount,
      xrpForAccount,
      log,
    });

    const deps = { client, config, accounts, setupId, env, log, onStep: options.onStep };

    // Issuer flags and asset distribution only apply to an issued token. A native-XRP vault has no
    // currency issuer, so these steps are skipped — accounts already hold XRP from funding.
    if (!isXrpAsset(config.asset)) {
      await configureIssuer(deps);
      await distributeAsset(deps, accounts.owner.wallet, "owner", coverAndLiquidity(config));
      for (const d of accounts.depositors) await distributeAsset(deps, d.wallet, `depositor[${d.index}]`, liquidityPerHolder(config));
      for (const b of accounts.borrowers) await distributeAsset(deps, b.wallet, `borrower[${b.index}]`, liquidityPerHolder(config));
    }

    // Credentials and the domain are only provisioned for a permissioned vault. A public vault skips
    // both — no credential is issued, no domain is created — so createVault below makes an open vault.
    if (config.domain) {
      await issueCredentials(deps);
      await createDomain(deps);
    }
    await createVault(deps);
    await createBroker(deps);

    // The single-owner invariant is checked the moment both objects exist.
    await assertSingleOwner(client, accounts.owner.address);

    await depositCover(deps);
    const { cover } = await assertCoverMeetsMinimum(client, accounts.owner.address, config.coverAmount);
    log(`cover seeded: ${cover}`);

    const path = saveEnvironment(env, options.outDir);
    log(`wrote ${path}`);
    return env;
  } finally {
    await client.disconnect();
  }
}

function toRecord(a: { role: ProvisionedAccount["role"]; index: number; address: string }): ProvisionedAccount {
  return { role: a.role, index: a.index, address: a.address };
}

// Owner needs enough of the asset to seed cover; a generous multiple keeps headroom for fees.
function coverAndLiquidity(config: Config): string {
  return String(Number(config.coverAmount) * 2);
}

// Each depositor/borrower receives enough to deposit and repay within the configured debt ceiling.
function liquidityPerHolder(config: Config): string {
  return config.debtMaximum;
}

// The XRP each account is funded with. For an IOU asset that is the flat funding amount — liquidity is
// minted to holders separately, so XRP only backs reserves and fees. For an XRP asset the flat amount
// is not enough: a holder must actually hold the XRP it deposits and the owner must hold its cover,
// because there is no minting. So each role is funded with the flat amount plus the liquidity that role
// moves — mirroring what coverAndLiquidity/liquidityPerHolder would have minted for an IOU.
function fundingPlan(config: Config): (account: DerivedAccount) => number {
  const base = config.fundingXrpPerAccount;
  if (!isXrpAsset(config.asset)) return () => base;
  return (account) => {
    switch (account.role) {
      case "owner":
        return base + Number(coverAndLiquidity(config));
      case "depositor":
      case "borrower":
        return base + Number(liquidityPerHolder(config));
      default:
        return base; // issuer owns no liquidity in an XRP session
    }
  };
}
