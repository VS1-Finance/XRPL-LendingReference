import {
  type Config,
  type DerivedAccount,
  type ReserveRates,
  type VaultShape,
  connect,
  decimalToScaled,
  deriveAccountSet,
  allAccounts,
  fanOutFunding,
  resolveTreasury,
  generateSetupId,
  isXrpAsset,
  readReserveRates,
  roleReserveDrops,
} from "@lending/shared";
import { assertCoverMeetsMinimum, assertSingleOwner } from "./assertions.js";
import {
  runBatch,
  issuerFlagSteps,
  trustSteps,
  distributeSteps,
  credentialCreateSteps,
  credentialAcceptSteps,
  createBroker,
  createDomain,
  createVault,
  depositCover,
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

  const accounts = deriveAccountSet(config.seed, config.pool, { permissioned: config.domain !== undefined });
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
      ...(accounts.credentialIssuer ? { credentialIssuer: toRecord(accounts.credentialIssuer) } : {}),
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

    // Fund every derived account by fanning XRP out from a treasury sized to the whole pool. Each role
    // is funded for the reserve it will actually need — the base reserve plus the increment for the
    // objects that role ends up owning — read live from the ledger, rather than a flat amount. For an
    // XRP vault there is no minting, so a holder is additionally funded for the liquidity it deposits.
    const reserveRates = await readReserveRates(client);
    const everyAccount = allAccounts(accounts);
    const dropsForAccount = fundingPlan(config, reserveRates);
    const totalDrops = everyAccount.reduce((sum, a) => sum + dropsForAccount(a), 0);
    const treasury = await resolveTreasury(client, everyAccount.length, totalDrops, log);
    await fanOutFunding(client, treasury, everyAccount, { dropsForAccount, log });

    const deps = { client, config, accounts, setupId, env, log, onStep: options.onStep };
    const roleLabel = (a: { role: string; index: number }) =>
      a.role === "owner" ? "owner" : `${a.role}[${a.index}]`;

    // Issuer flags and asset distribution only apply to an issued token. A native-XRP vault has no
    // currency issuer, so these steps are skipped — accounts already hold XRP from funding.
    if (!isXrpAsset(config.asset)) {
      // Batch 2: issuer flags (chained within the issuer's sequence).
      await runBatch(deps, issuerFlagSteps(deps));
      // Batch 3: trust lines (one per holder + owner, all different accounts).
      const holders = [accounts.owner, ...accounts.depositors, ...accounts.borrowers];
      await runBatch(deps, holders.flatMap((h) => trustSteps(deps, h.wallet, roleLabel(h))));
      // Batch 4: distributions (all from the issuer).
      await runBatch(deps, [
        ...distributeSteps(deps, accounts.owner.wallet, "owner", coverAndLiquidity(config)),
        ...accounts.depositors.flatMap((d) => distributeSteps(deps, d.wallet, `depositor[${d.index}]`, liquidityPerHolder(config))),
        ...accounts.borrowers.flatMap((b) => distributeSteps(deps, b.wallet, `borrower[${b.index}]`, liquidityPerHolder(config))),
      ]);
    }

    // Credentials and the domain are only provisioned for a permissioned vault. A public vault skips
    // both — no credential is issued, no domain is created — so createVault below makes an open vault.
    if (config.domain) {
      await runBatch(deps, credentialCreateSteps(deps));
      await runBatch(deps, credentialAcceptSteps(deps));
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

// The drops each account is funded with. The base is the role's minimum reserve — the base reserve plus
// the increment for the objects that role will own — read live from the ledger, so an account that owns
// nothing (the issuer, the credential issuer) is funded minimally rather than bulk-loaded. For an IOU
// vault that reserve is all an account needs, because liquidity is minted to holders separately. For an
// XRP vault there is no minting, so a holder is additionally funded for the liquidity it moves: the
// owner for the cover it seeds, each depositor/borrower for the amount it deposits or repays. Everything
// is in integer drops — the caller sums these across the pool, and rounding to XRP first would let
// floating-point error accumulate into a value the ledger's drops conversion rejects.
function fundingPlan(config: Config, rates: ReserveRates): (account: DerivedAccount) => number {
  const shape: VaultShape = {
    isXrp: isXrpAsset(config.asset),
    permissioned: config.domain !== undefined,
    credentialedMembers: config.domain ? config.pool.depositors + config.pool.borrowers : 0,
  };
  const liquidityDrops = (value: string) => Number(decimalToScaled(value, 6));
  return (account) => {
    const reserve = roleReserveDrops(account.role, shape, rates);
    if (!shape.isXrp) return reserve; // IOU liquidity is minted, not funded
    switch (account.role) {
      case "owner":
        return reserve + liquidityDrops(coverAndLiquidity(config));
      case "depositor":
      case "borrower":
        return reserve + liquidityDrops(liquidityPerHolder(config));
      default:
        return reserve; // issuer and credential issuer own no liquidity in an XRP session
    }
  };
}
