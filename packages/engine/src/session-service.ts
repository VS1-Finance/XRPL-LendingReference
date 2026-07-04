import { createHash } from "node:crypto";
import type { Config } from "@lending/shared";
import { createSession, SessionRegistry, type Session, type SessionSummary } from "@lending/session";

// Owns the live sessions the engine serves. It provisions new sessions from the base configuration —
// each with a unique setup id and derivation seed so they do not collide on-chain — and keeps them in
// the registry for the API to act on.
export class SessionService {
  private readonly registry = new SessionRegistry();

  constructor(private readonly baseConfig: Config) {}

  // Provision a fresh session and register it. A short label may be supplied to make a session easier
  // to recognize; the on-chain identity is always unique regardless.
  async create(label?: string): Promise<SessionSummary> {
    const token = this.uniqueToken(label);
    const config: Config = {
      ...this.baseConfig,
      seed: `${this.baseConfig.seed}-${token}`,
      setupId: `session-${token}`,
    };
    const session = await createSession(config);
    this.registry.register(session);
    return this.summaryOf(session.setupId)!;
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

  // A short unique token for a new session. Derived from a monotonic counter and the wall clock so it
  // is unique per process without pulling in extra dependencies.
  private counter = 0;
  private uniqueToken(label?: string): string {
    const base = `${Date.now().toString(36)}${(this.counter++).toString(36)}`;
    const suffix = label ? `-${label.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}` : "";
    return `${createHash("sha256").update(base).digest("hex").slice(0, 8)}${suffix}`;
  }
}
