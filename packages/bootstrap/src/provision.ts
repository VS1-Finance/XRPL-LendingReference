import {
  type Config,
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
import type { ProvisionedAccount, ProvisionedEnvironment } from "./types.js";

export interface ProvisionOptions {
  outDir?: string;
  log?: (msg: string) => void;
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
    credentialType: config.domain.acceptedCredentials[0]!.credentialType,
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

    // Fund every derived account by fanning XRP out from a treasury sized to the whole pool.
    const everyAccount = allAccounts(accounts);
    const treasury = await fundTreasuryForTargets(client, everyAccount.length, config.fundingXrpPerAccount, log);
    await fanOutFunding(client, treasury, everyAccount, {
      xrpPerAccount: config.fundingXrpPerAccount,
      log,
    });

    const deps = { client, config, accounts, setupId, env, log };

    await configureIssuer(deps);

    // Owner and every pool member need the asset to fund the vault, cover, and repayments.
    await distributeAsset(deps, accounts.owner.wallet, "owner", coverAndLiquidity(config));
    for (const d of accounts.depositors) await distributeAsset(deps, d.wallet, `depositor[${d.index}]`, liquidityPerHolder(config));
    for (const b of accounts.borrowers) await distributeAsset(deps, b.wallet, `borrower[${b.index}]`, liquidityPerHolder(config));

    await issueCredentials(deps);
    await createDomain(deps);
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
