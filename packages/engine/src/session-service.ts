import { createHash } from "node:crypto";
import type { Config } from "@lending/shared";
import type { StepRecord } from "@lending/bootstrap";
import { createSession, SessionRegistry, type Session, type SessionSummary } from "@lending/session";
import type { EngineStore, StoredAction } from "./store.js";

// Owns the live sessions the engine serves. It provisions new sessions from the base configuration —
// each with a unique setup id and derivation seed so they do not collide on-chain — keeps them in the
// registry for the API to act on, and persists them to the store so they survive a restart. No secret
// is persisted: a session's derivation token plus the base seed re-derive every wallet at load.
export class SessionService {
  private readonly registry = new SessionRegistry();
  // The derivation token for each live session, needed to reconstruct the seed when reloading.
  private readonly tokens = new Map<string, string>();

  constructor(
    private readonly baseConfig: Config,
    private readonly store: EngineStore,
  ) {}

  // Provision a fresh session, register it, and persist it with its initial (all-bot) occupancy. A
  // short label may be supplied to make a session easier to recognize; the on-chain identity is always
  // unique regardless. An optional onStep sink receives each provisioning step as it settles.
  async create(label?: string, onStep?: (record: StepRecord) => void): Promise<SessionSummary> {
    const token = this.uniqueToken(label);
    const config: Config = {
      ...this.baseConfig,
      seed: `${this.baseConfig.seed}-${token}`,
      setupId: `session-${token}`,
    };
    const session = await createSession(config, onStep);
    this.registry.register(session);
    this.tokens.set(session.setupId, token);

    const summary = this.summaryOf(session.setupId)!;
    await this.store.saveSession(
      { setupId: session.setupId, token, network: session.network, label, env: session.env },
      summary.seats.map((s) => ({ seatKey: s.key, occupant: s.occupant })),
    );
    // Record the provisioning steps as the genesis of the session's log, so the Activity view shows
    // how the environment was built — before any human or bot action.
    await this.store.saveProvisioningSteps(
      session.setupId,
      session.env.steps.map((s) => ({ action: s.action, result: s.result, ...(s.txHash ? { txHash: s.txHash } : {}) })),
    );
    return summary;
  }

  // Reload every persisted session on boot: re-derive its seed from the base seed and stored token,
  // re-attach it to the ledger, and restore who held each seat. Sessions survive an engine restart.
  async loadPersisted(): Promise<number> {
    const stored = await this.store.loadAllSessions();
    for (const s of stored) {
      const seed = `${this.baseConfig.seed}-${s.token}`;
      const session = await this.registry.attachFrom(s.env, seed);
      this.tokens.set(s.setupId, s.token);
      const occupancy = await this.store.loadOccupancy(s.setupId);
      for (const o of occupancy) {
        const seat = session.seats.get(o.seatKey);
        if (seat) seat.occupant = o.occupant;
      }
    }
    return stored.length;
  }

  list(): SessionSummary[] {
    return this.registry.list();
  }

  get(setupId: string): Session | undefined {
    return this.registry.get(setupId);
  }

  summaryOf(setupId: string): SessionSummary | undefined {
    return this.registry.list().find((s) => s.setupId === setupId);
  }

  registryHandle(): SessionRegistry {
    return this.registry;
  }

  // Claim a seat and persist the new occupancy. A participant holds one seat at a time, so any other
  // seat they currently hold is released first — taking a role gives up the previous one.
  async claimSeat(setupId: string, seatKey: string, humanId: string): Promise<void> {
    const session = this.get(setupId);
    if (session) {
      for (const [key, seat] of session.seats) {
        if (key !== seatKey && seat.occupant.kind === "human" && seat.occupant.id === humanId) {
          this.registry.releaseSeat(setupId, key, humanId);
          const released = session.seats.get(key);
          if (released) await this.store.saveOccupancy(setupId, key, released.occupant);
        }
      }
    }
    this.registry.claimSeat(setupId, seatKey, humanId);
    await this.store.saveOccupancy(setupId, seatKey, { kind: "human", id: humanId });
  }

  // Release a seat and persist the new occupancy.
  async releaseSeat(setupId: string, seatKey: string, humanId: string): Promise<void> {
    this.registry.releaseSeat(setupId, seatKey, humanId);
    const seat = this.get(setupId)?.seats.get(seatKey);
    if (seat) await this.store.saveOccupancy(setupId, seatKey, seat.occupant);
  }

  // Record an action in the durable log (human, bot, or system).
  async recordAction(setupId: string, action: Omit<StoredAction, "seq" | "ts">): Promise<void> {
    await this.store.appendAction(setupId, action);
  }

  // The action log for a session.
  async log(setupId: string): Promise<StoredAction[]> {
    return this.store.getLog(setupId);
  }

  // A short unique token for a new session. Derived from a monotonic counter and the wall clock so it
  // is unique per process without pulling in extra dependencies.
  private counter = 0;
  private uniqueToken(label?: string): string {
    const base = `${Date.now().toString(36)}${(this.counter++).toString(36)}`;
    const suffix = label ? `-${label.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}` : "";
    return `${createHash("sha256").update(base).digest("hex").slice(0, 8)}${suffix}`;
  }
}
