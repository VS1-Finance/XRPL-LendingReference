import {
  accountObjects,
  deriveAccount,
  fanOutFunding,
  resolveTreasury,
  isMptAsset,
  isXrpAsset,
  readReserveRates,
  roleReserveDrops,
  type Config,
  type VaultShape,
} from "@lending/shared";
import {
  credentialAcceptSteps,
  credentialCreateSteps,
  distributeSteps,
  isPermissioned,
  mptAuthorizeSteps,
  mptDistributeSteps,
  runBatch,
  trustSteps,
  type ProvisionedAccount,
  type StepDeps,
} from "@lending/bootstrap";
import { ServerSigner } from "./signer.js";
import { fillWithBot, keyOf, type Seat } from "./seat.js";
import type { Session } from "./session.js";

// Add one participant to a running session at runtime. Mirrors the per-member slice of provision():
// derive the next-index account, fund it (reserve, plus the XRP liquidity it must hold for a native
// vault since there is no minting), then run just that member's on-ledger recipe — trust + distribute
// for an IOU, MPTokenAuthorize + distribute for an MPT vault, credential create + accept for a
// permissioned vault, funding only for a public XRP vault. Finally add a bot-occupied seat and append
// the account to the environment. Persisting the environment is the engine layer's job; this does not
// touch Postgres or the bot loop beyond seating the new role.
export async function addParticipant(
  session: Session,
  role: "depositor" | "borrower",
  seed: string,
  config: Config,
): Promise<ProvisionedAccount> {
  const log = (_m: string) => {};
  const permissioned = isPermissioned(session.env);
  const isXrp = isXrpAsset(config.asset);
  const isMpt = isMptAsset(config.asset);
  const plural = role === "depositor" ? "depositors" : "borrowers";

  // Next free index for the role: the account is derived deterministically from (seed, role, index),
  // so the next index is however many of this role the environment already holds.
  const index = session.env.accounts[plural].length;
  const derived = deriveAccount(seed, role, index);

  // Reserve floor for this role, read live from the ledger. A native-XRP holder additionally holds
  // the liquidity it will move — recovered from the broker's DebtMaximum, which for an XRP vault the
  // ledger already stores in drops (see steps.ts: DebtMaximum = xrpToDrops(debtMaximum) at create),
  // so it is added directly, not converted again. IOU and MPT liquidity is minted/distributed via a
  // Payment below, not funded — the MPT holder's reserve floor still needs the extra owner-count unit
  // its MPToken object reserves, same as an IOU holder's trust line, which VaultShape.isXrp=false
  // already accounts for (MPT shares the IOU branch for reserve sizing).
  const rates = await readReserveRates(session.client);
  const shape: VaultShape = { isXrp, permissioned, credentialedMembers: 1 };
  const reserveDrops = roleReserveDrops(role, shape, rates);
  let liquidityDrops = 0;
  if (isXrp) {
    const brokers = await accountObjects(session.client, session.env.accounts.owner.address, "loan_broker");
    const debtMaximum = brokers[0]?.DebtMaximum;
    liquidityDrops = Number(debtMaximum ?? 0);
  }
  const totalDrops = reserveDrops + liquidityDrops;

  const treasury = await resolveTreasury(session.client, 1, totalDrops, log);
  await fanOutFunding(session.client, treasury, [derived], { dropsForAccount: () => totalDrops, log });

  // A StepDeps scoped to just this member: the builders read deps.accounts.{issuer,credentialIssuer,
  // owner} and the single-element depositors/borrowers array. The scoped member is exactly the derived
  // account (the builders read member.wallet / member.role / member.index off it).
  const deps: StepDeps = {
    client: session.client,
    config,
    accounts: {
      issuer: deriveAccount(seed, "issuer", 0),
      ...(permissioned ? { credentialIssuer: deriveAccount(seed, "credentialIssuer", 0) } : {}),
      owner: deriveAccount(seed, "owner", 0),
      depositors: role === "depositor" ? [derived] : [],
      borrowers: role === "borrower" ? [derived] : [],
    },
    setupId: session.env.setupId,
    env: session.env,
    log,
  };

  // The on-ledger recipe for this one member, matching provision(): trust then distribute for an IOU;
  // MPTokenAuthorize then distribute for an MPT vault (the MPT parallel to trust+distribute — the
  // holder opts in, then the issuer pays it its liquidity); credential create then a separate accept
  // for a permissioned vault; nothing extra for a public XRP vault (it is already funded above).
  // trustSteps/distributeSteps/mptAuthorizeSteps/mptDistributeSteps are all no-ops for XRP, so guarding
  // on isXrp/isMpt keeps the intent explicit rather than relying on their internal short-circuit.
  // Label with the pool index (matching provision's `role[index]` form) so each runtime add records a
  // distinct step/correlation id rather than colliding on a bare role name.
  const label = `${role}[${index}]`;
  if (isMpt) {
    await runBatch(deps, mptAuthorizeSteps(deps, derived.wallet, label));
    await runBatch(deps, mptDistributeSteps(deps, derived.wallet, label, config.debtMaximum));
  } else if (!isXrp) {
    await runBatch(deps, trustSteps(deps, derived.wallet, label));
    await runBatch(deps, distributeSteps(deps, derived.wallet, label, config.debtMaximum));
  }
  if (permissioned) {
    await runBatch(deps, credentialCreateSteps(deps));
    await runBatch(deps, credentialAcceptSteps(deps));
  }

  // Seat the new role, bot-occupied, mirroring buildSeats in session.ts.
  const seat: Seat = { role, index, address: derived.address, signer: new ServerSigner(session.client, derived.wallet), occupant: { kind: "open" } };
  fillWithBot(seat);
  session.seats.set(keyOf(seat), seat);

  // Append to the environment — the same object the engine layer persists.
  session.env.accounts[plural].push({ role, index, address: derived.address });

  return { role, index, address: derived.address };
}
