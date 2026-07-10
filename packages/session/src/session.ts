import { connect, deriveAccount, type Config, type Network, type Role } from "@lending/shared";
import { provision, type ProvisionedEnvironment, type StepRecord } from "@lending/bootstrap";
import type { Client } from "xrpl";
import { ServerSigner } from "./signer.js";
import { fillWithBot, keyOf, type Seat } from "./seat.js";

// A session is a provisioned environment together with its seat map. Each role in the environment
// becomes a seat bound to that role's derived account; on creation every seat is filled by a bot,
// and humans claim seats to take over a role.
export interface Session {
  setupId: string;
  network: Network;
  seed: string;
  env: ProvisionedEnvironment;
  seats: Map<string, Seat>;
  client: Client;
}

// Create a session: provision a fresh environment, connect, and build a seat per role with each
// seat bot-filled and backed by a server signer over its derived account. An optional onStep sink
// receives each provisioning step as it settles, so a caller can stream progress.
export async function createSession(
  config: Config,
  onStep?: (record: StepRecord) => void,
): Promise<Session> {
  const env = await provision(config, { onStep });
  const client = await connect(config.network);
  const seats = buildSeats(client, env, config.seed);
  return { setupId: env.setupId, network: config.network, seed: config.seed, env, seats, client };
}

// Rebuild a session's in-memory handle from an already-provisioned environment (for example when a
// second participant joins a session that another process created). The seed must match the
// environment so the seat accounts derive correctly.
export async function attachSession(env: ProvisionedEnvironment, seed: string): Promise<Session> {
  const client = await connect(env.network as Network);
  const seats = buildSeats(client, env, seed);
  return { setupId: env.setupId, network: env.network as Network, seed, env, seats, client };
}

export async function closeSession(session: Session): Promise<void> {
  await session.client.disconnect();
}

function buildSeats(client: Client, env: ProvisionedEnvironment, seed: string): Map<string, Seat> {
  const seats = new Map<string, Seat>();
  const add = (role: Role, index: number, address: string) => {
    const derived = deriveAccount(seed, role, index);
    if (derived.address !== address) {
      throw new Error(`seed does not match environment: ${role}[${index}] derives ${derived.address}, expected ${address}`);
    }
    const seat: Seat = { role, index, address, signer: new ServerSigner(client, derived.wallet), occupant: { kind: "open" } };
    fillWithBot(seat);
    seats.set(keyOf(seat), seat);
  };

  add("issuer", env.accounts.issuer.index, env.accounts.issuer.address);
  add("owner", env.accounts.owner.index, env.accounts.owner.address);
  for (const d of env.accounts.depositors) add("depositor", d.index, d.address);
  for (const b of env.accounts.borrowers) add("borrower", b.index, b.address);
  return seats;
}
