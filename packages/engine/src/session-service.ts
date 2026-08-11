import { createHash } from "node:crypto";
import type { Config } from "@lending/shared";
import { isPermissioned, type StepRecord } from "@lending/bootstrap";
import { addParticipant, createSession, seatKey, SessionRegistry, type Session, type SessionSummary } from "@lending/session";
import type { EngineStore, StoredAction } from "./store.js";

// The largest pool a single session may request. Each participant is a funded ledger account with
// trust lines and a credential, so an unbounded pool would ask the faucet and the ledger for far too
// much; 20 per side keeps a session provisionable in a reasonable time.
const MAX_POOL = 20;

// A pooled role is already at MAX_POOL — a state conflict (409), distinct from a validation error (400)
// or an on-ledger/faucet failure (500), so the route can map it precisely.
export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

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
  // The effective bot seed for each session (supplied or generated), used to seed the variant
  // assignment when the pool starts, and surfaced so a run can be reproduced by re-entering it. Held
  // in-memory for the process lifetime only, and lost on restart — matching `scenarios`; a reloaded
  // session falls back to the base seed and is not byte-reproducible after a restart.
  private readonly botSeeds = new Map<string, string>();

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
    // Optional bot seed. Fixes the variant assignment so a run's behaviour mix is reproducible; when
    // omitted a fresh seed is generated and stored. Only the variant mix is reproducible — not action
    // timing (live-ledger reads and close timing still vary).
    botSeed?: string;
    // Whether the vault is permissioned (domain-gated, the default) or public (open, no domain and no
    // credentials). Omit or true → permissioned; false → public.
    permissioned?: boolean;
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
      // The vault asset. "XRP" (the UI's default) provisions a native-XRP vault — no currency issuer,
      // no trust lines, no clawback; the provisioning path keys all of that off isXrpAsset. Any other
      // value is an IOU currency, with the issuer filled in at provision time from the derived issuer
      // account (issuer omitted here). Only an omitted asset falls back to the base config.
      ...(opts.asset
        ? opts.asset.toUpperCase() === "XRP"
          ? { asset: { currency: "XRP" } }
          : { asset: { currency: normalizeCurrency(opts.asset) } }
        : {}),
      // A public vault drops the domain entirely — no gate, no credentials. Permissioned keeps the base
      // config's domain. Explicit false is the only way to opt out; the default stays permissioned.
      ...(opts.permissioned === false ? { domain: undefined } : {}),
      ...(opts.coverAmount ? { coverAmount: opts.coverAmount } : {}),
      // Loan ceiling. An XRP vault funds each holder debtMaximum XRP of real liquidity from the faucet
      // (an IOU vault mints it), so the base config's large default is faucet-hostile for XRP: default
      // it to a small, provisionable ceiling when the caller gives none. An explicit value always wins.
      ...(opts.debtMaximum
        ? { debtMaximum: opts.debtMaximum }
        : opts.asset?.toUpperCase() === "XRP"
          ? { debtMaximum: "500" }
          : {}),
      ...(opts.coverRatePercent !== undefined ? { coverRateMinimum: pctToScaled(opts.coverRatePercent) } : {}),
      ...(opts.liquidationRatePercent !== undefined ? { coverRateLiquidation: pctToScaled(opts.liquidationRatePercent) } : {}),
      ...(opts.managementFeePercent !== undefined ? { managementFeeRate: pctToScaled(opts.managementFeePercent) } : {}),
    };
    const session = await createSession(config, opts.onStep);
    this.registry.register(session);
    this.tokens.set(session.setupId, token);
    if (opts.scenario) this.scenarios.set(session.setupId, opts.scenario);
    // Use the supplied seed if non-blank, else generate a short legible one from the session token so
    // it is easy to read off the Info tab and re-enter to reproduce the variant assignment.
    const botSeed = opts.botSeed?.trim() || `seed-${createHash("sha256").update(token).digest("hex").slice(0, 8)}`;
    this.botSeeds.set(session.setupId, botSeed);

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

  // Add one participant to a running session at runtime, bot-free (the caller — the route — owns
  // restarting the bot scheduler so the new seat is driven). Reconstructs the same seed and effective
  // config `create` used, recovered from the session's env: asset from env.asset, and domain/permissioned
  // from the on-ledger domain via isPermissioned. debtMaximum (used only for an IOU distribute) stays
  // from the base config — a session provisioned with a custom debtMaximum override is an edge case,
  // and the XRP-liquidity path already reads the true value live from the ledger inside addParticipant.
  //
  // Partial-failure note (carry-over review finding): if the on-ledger addParticipant call throws after
  // creating the credential but before accept, a retry re-runs CredentialCreate → tecDUPLICATE → fatal.
  // That is inherited from the shared builders and out of scope to fix here; this method only needs to
  // let the error propagate cleanly (no swallow) and never persist a half-added seat — the store writes
  // below run only once the on-ledger call has returned successfully.
  async addParticipant(setupId: string, role: "depositor" | "borrower"): Promise<SessionSummary> {
    const session = this.get(setupId);
    if (!session) throw new Error(`no session ${setupId}`);

    const plural = role === "depositor" ? "depositors" : "borrowers";
    if (session.env.accounts[plural].length >= MAX_POOL) throw new CapacityError(`the ${plural} pool is at capacity (${MAX_POOL})`);

    const token = this.tokens.get(setupId)!;
    const seed = `${this.baseConfig.seed}-${token}`;
    const config: Config = {
      ...this.baseConfig,
      seed,
      setupId,
      asset: session.env.asset,
      domain: isPermissioned(session.env) ? this.baseConfig.domain : undefined,
    };

    const record = await addParticipant(session, role, seed, config);

    await this.store.updateSessionEnv(setupId, session.env);
    await this.store.createOccupancy(setupId, seatKey(role, record.index), { kind: "bot" });
    await this.recordAction(setupId, { actor: seatKey(role, record.index), role, by: "system", action: "add-participant", code: "tesSUCCESS" });

    return this.summaryOf(setupId)!;
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
    const summary = this.registry.list().find((s) => s.setupId === setupId);
    if (summary) {
      // The registry summary is built from the Session, which does not carry the scenario or bot seed;
      // overlay them from the per-session maps so every read (create, GET /sessions/:id, the SSE done
      // event) reports the real values, not just the moment right after create.
      summary.scenario = this.scenarios.get(setupId);
      summary.botSeed = this.botSeeds.get(setupId);
    }
    return summary;
  }

  registryHandle(): SessionRegistry {
    return this.registry;
  }

  // The effective bot seed for a session, if any — used to seed the variant assignment.
  botSeedFor(setupId: string): string | undefined {
    return this.botSeeds.get(setupId);
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
