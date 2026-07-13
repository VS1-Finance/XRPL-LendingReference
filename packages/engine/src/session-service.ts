import { createHash } from "node:crypto";
import type { Config } from "@lending/shared";
import type { StepRecord } from "@lending/bootstrap";
import { createSession, SessionRegistry, type Session, type SessionSummary } from "@lending/session";
import type { EngineStore, StoredAction } from "./store.js";

// The largest pool a single session may request. Each participant is a funded ledger account with
// trust lines and a credential, so an unbounded pool would ask the faucet and the ledger for far too
// much; 20 per side keeps a session provisionable in a reasonable time.
const MAX_POOL = 20;

function clampPool(requested: number | undefined, fallback: number): number {
  const n = typeof requested === "number" && Number.isFinite(requested) ? Math.round(requested) : fallback;
  return Math.max(1, Math.min(MAX_POOL, n));
}

// Rates are stored as scaled integers where 100% is 100000, so a percentage is multiplied by 1000.
function pctToScaled(percent: number): number {
  return Math.max(0, Math.round(percent * 1000));
}

// A vault currency is either a 3-character code used as-is, or any other string encoded as a 40-char
// hex currency code (the ledger's representation for non-standard currencies).
function normalizeCurrency(currency: string): string {
  const c = currency.trim();
  if (/^[0-9A-Fa-f]{40}$/.test(c)) return c.toUpperCase();
  if (c.length === 3) return c;
  const hex = Buffer.from(c, "utf8").toString("hex").toUpperCase();
  return hex.padEnd(40, "0").slice(0, 40);
}

// Owns the live sessions the engine serves. It provisions new sessions from the base configuration —
// each with a unique setup id and derivation seed so they do not collide on-chain — keeps them in the
// registry for the API to act on, and persists them to the store so they survive a restart. No secret
// is persisted: a session's derivation token plus the base seed re-derive every wallet at load.
export class SessionService {
  private readonly registry = new SessionRegistry();
  // The derivation token for each live session, needed to reconstruct the seed when reloading.
  private readonly tokens = new Map<string, string>();
  // The bot scenario chosen for each session, used to weight the bot pool when it starts.
  private readonly scenarios = new Map<string, string>();

  constructor(
    private readonly baseConfig: Config,
    private readonly store: EngineStore,
  ) {}

  // Provision a fresh session, register it, and persist it with its initial (all-bot) occupancy. A
  // short label may be supplied to make a session easier to recognize; the on-chain identity is always
  // unique regardless. Pool sizes override the base config's, clamped to a sane maximum so a request
  // cannot ask the ledger to fund an unbounded number of accounts. An optional onStep sink receives
  // each provisioning step as it settles.
  async create(opts: {
    label?: string;
    depositors?: number;
    borrowers?: number;
    // Optional overrides onto the base config. asset is a non-XRP currency code (the harness stands up
    // its own issuer); the rate fields are percentages (converted to the ledger's scaled integers);
    // cover and debt are whole-unit decimal strings.
    asset?: string;
    coverRatePercent?: number;
    liquidationRatePercent?: number;
    managementFeePercent?: number;
    coverAmount?: string;
    debtMaximum?: string;
    // Bot behaviour preset (calm | mixed | defaults), used to weight the pool when it runs.
    scenario?: string;
    onStep?: (record: StepRecord) => void;
  } = {}): Promise<SessionSummary> {
    const token = this.uniqueToken(opts.label);
    const config: Config = {
      ...this.baseConfig,
      seed: `${this.baseConfig.seed}-${token}`,
      setupId: `session-${token}`,
      pool: {
        depositors: clampPool(opts.depositors, this.baseConfig.pool.depositors),
        borrowers: clampPool(opts.borrowers, this.baseConfig.pool.borrowers),
      },
      // A different vault asset: a non-XRP IOU currency, with the issuer filled in at provision time
      // from the derived issuer account (issuer omitted here).
      ...(opts.asset && opts.asset.toUpperCase() !== "XRP"
        ? { asset: { currency: normalizeCurrency(opts.asset) } }
        : {}),
      ...(opts.coverAmount ? { coverAmount: opts.coverAmount } : {}),
      ...(opts.debtMaximum ? { debtMaximum: opts.debtMaximum } : {}),
      ...(opts.coverRatePercent !== undefined ? { coverRateMinimum: pctToScaled(opts.coverRatePercent) } : {}),
      ...(opts.liquidationRatePercent !== undefined ? { coverRateLiquidation: pctToScaled(opts.liquidationRatePercent) } : {}),
      ...(opts.managementFeePercent !== undefined ? { managementFeeRate: pctToScaled(opts.managementFeePercent) } : {}),
    };
    const session = await createSession(config, opts.onStep);
    this.registry.register(session);
    this.tokens.set(session.setupId, token);
    if (opts.scenario) this.scenarios.set(session.setupId, opts.scenario);

    const summary = this.summaryOf(session.setupId)!;
    await this.store.saveSession(
      { setupId: session.setupId, token, network: session.network, label: opts.label, env: session.env },
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

  // The bot scenario chosen for a session, if any — used to weight the pool when it starts.
  scenarioFor(setupId: string): string | undefined {
    return this.scenarios.get(setupId);
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
