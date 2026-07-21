import { isPermissioned, loadEnvironment, saveEnvironment, type ProvisionedEnvironment } from "@lending/bootstrap";
import { claim, release, type Occupant, type Seat } from "./seat.js";
import { attachSession, type Session } from "./session.js";

// A view of a session suitable for listing and joining: which seats exist and who holds each, plus the
// vault's shape (asset and whether it is permissioned) so a client can render the right mode.
export interface SessionSummary {
  setupId: string;
  network: string;
  // The vault asset: "XRP" for a native vault, or the currency code for an IOU vault.
  asset: string;
  // Whether the vault is domain-gated (permissioned) or open (public).
  permissioned: boolean;
  seats: { key: string; role: string; address: string; occupant: Occupant }[];
  openSeats: string[];
}

// An in-memory registry of live sessions, so sessions can be discovered and joined. The provisioned
// graph of each session is also written to disk (keyed by setup id) so a separate process can attach
// to a session it did not create.
export class SessionRegistry {
  private sessions = new Map<string, Session>();

  register(session: Session, dir?: string): void {
    this.sessions.set(session.setupId, session);
    saveEnvironment(session.env, dir);
  }

  get(setupId: string): Session | undefined {
    return this.sessions.get(setupId);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(summarize);
  }

  // Attach to a session that exists on disk but is not yet live in this process, and register it.
  async attach(setupId: string, seed: string, dir?: string): Promise<Session> {
    const existing = this.sessions.get(setupId);
    if (existing) return existing;
    const env = loadEnvironment(setupId, dir);
    if (!env) throw new Error(`no session found for ${setupId}`);
    return this.attachFrom(env, seed);
  }

  // Attach to a session from an already-loaded environment (for example one read from a database
  // rather than disk), and register it. Returns the existing handle if it is already live.
  async attachFrom(env: ProvisionedEnvironment, seed: string): Promise<Session> {
    const existing = this.sessions.get(env.setupId);
    if (existing) return existing;
    const session = await attachSession(env, seed);
    this.sessions.set(env.setupId, session);
    return session;
  }

  // A human claims a seat in a session; the seat's bot stands down on its next tick.
  claimSeat(setupId: string, seatKey: string, humanId: string): void {
    claim(this.requireSeat(setupId, seatKey), humanId);
  }

  // A human releases a seat back to open, where a bot may fill it again.
  releaseSeat(setupId: string, seatKey: string, humanId: string): void {
    release(this.requireSeat(setupId, seatKey), humanId);
  }

  private requireSeat(setupId: string, seatKey: string): Seat {
    const session = this.sessions.get(setupId);
    if (!session) throw new Error(`no session found for ${setupId}`);
    const seat = session.seats.get(seatKey);
    if (!seat) throw new Error(`session ${setupId} has no seat ${seatKey}`);
    return seat;
  }
}

function summarize(session: Session): SessionSummary {
  const seats = [...session.seats.values()].map((s) => ({ key: `${s.role}:${s.index}`, role: s.role, address: s.address, occupant: s.occupant }));
  return {
    setupId: session.setupId,
    network: session.network,
    asset: session.env.asset.currency,
    permissioned: isPermissioned(session.env),
    seats,
    openSeats: seats.filter((s) => s.occupant.kind !== "human").map((s) => s.key),
  };
}

export type { ProvisionedEnvironment };
