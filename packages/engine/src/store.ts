import type { ProvisionedEnvironment } from "@lending/bootstrap";
import type { Occupant } from "@lending/session";
import { PrismaClient } from "./generated/prisma/index.js";

// The engine's durable store: the sessions it is serving, seat occupancy, and the action log. Wraps a
// Prisma client over the engine's own Postgres (separate from the ingester's history store). No
// secrets are persisted — a session keeps its derivation token and public environment, and wallets are
// re-derived from the configured seed at load.

// A persisted session, enough to reconstruct the live handle: the token re-derives the wallets, and
// the environment carries the account addresses and object ids.
export interface StoredSession {
  setupId: string;
  token: string;
  network: string;
  label?: string;
  env: ProvisionedEnvironment;
}

// One row for the action log, as stored. Formatting for display happens in the client.
export interface StoredAction {
  seq: number;
  ts: number;
  actor: string;
  role: string;
  by: "human" | "bot" | "system";
  action: string;
  code: string;
  hash?: string;
  params?: Record<string, string>;
}

export class EngineStore {
  private readonly db: PrismaClient;

  constructor() {
    if (!process.env.ENGINE_DATABASE_URL) {
      throw new Error("ENGINE_DATABASE_URL is required — the engine persists to Postgres (see packages/engine/.env.example)");
    }
    this.db = new PrismaClient();
  }

  // Fail fast at startup if the database is unreachable, so the engine does not accept traffic it
  // cannot persist.
  async connect(): Promise<void> {
    await this.db.$queryRaw`SELECT 1`;
  }

  async disconnect(): Promise<void> {
    await this.db.$disconnect();
  }

  // Persist a freshly provisioned session and its initial (all-bot) occupancy in one transaction.
  async saveSession(session: StoredSession, occupancy: { seatKey: string; occupant: Occupant }[]): Promise<void> {
    const { objects } = session.env;
    await this.db.$transaction([
      this.db.session.create({
        data: {
          setupId: session.setupId,
          token: session.token,
          network: session.network,
          label: session.label ?? null,
          vaultId: objects.vaultId ?? null,
          brokerId: objects.brokerId ?? null,
          domainId: objects.domainId ?? null,
          shareMptId: objects.shareMptId ?? null,
          env: session.env as unknown as object,
        },
      }),
      ...occupancy.map((o) =>
        this.db.seatOccupancy.create({
          data: {
            setupId: session.setupId,
            seatKey: o.seatKey,
            kind: o.occupant.kind,
            participant: o.occupant.kind === "human" ? o.occupant.id : null,
          },
        }),
      ),
    ]);
  }

  // Write through a seat's occupancy on claim or release.
  async saveOccupancy(setupId: string, seatKey: string, occupant: Occupant): Promise<void> {
    await this.db.seatOccupancy.update({
      where: { setupId_seatKey: { setupId, seatKey } },
      data: {
        kind: occupant.kind,
        participant: occupant.kind === "human" ? occupant.id : null,
      },
    });
  }

  // Append one action to a session's log. `seq` is assigned here as the next value for the session, so
  // ordering is stable regardless of concurrency.
  async appendAction(setupId: string, action: Omit<StoredAction, "seq" | "ts">): Promise<void> {
    const last = await this.db.actionLog.findFirst({
      where: { setupId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    await this.db.actionLog.create({
      data: {
        setupId,
        seq: (last?.seq ?? 0) + 1,
        actor: action.actor,
        role: action.role,
        by: action.by,
        action: action.action,
        code: action.code,
        hash: action.hash ?? null,
        params: (action.params ?? undefined) as object | undefined,
      },
    });
  }

  // The action log for a session, oldest first.
  async getLog(setupId: string): Promise<StoredAction[]> {
    const rows = await this.db.actionLog.findMany({
      where: { setupId },
      orderBy: { seq: "asc" },
    });
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts.getTime(),
      actor: r.actor,
      role: r.role,
      by: r.by as StoredAction["by"],
      action: r.action,
      code: r.code,
      hash: r.hash ?? undefined,
      params: (r.params as Record<string, string> | null) ?? undefined,
    }));
  }

  // Every persisted session, for reload on boot.
  async loadAllSessions(): Promise<StoredSession[]> {
    const rows = await this.db.session.findMany();
    return rows.map((r) => ({
      setupId: r.setupId,
      token: r.token,
      network: r.network,
      label: r.label ?? undefined,
      env: r.env as unknown as ProvisionedEnvironment,
    }));
  }

  // The persisted occupancy for a session, to restore who held which seat.
  async loadOccupancy(setupId: string): Promise<{ seatKey: string; occupant: Occupant }[]> {
    const rows = await this.db.seatOccupancy.findMany({ where: { setupId } });
    return rows.map((r) => ({
      seatKey: r.seatKey,
      occupant:
        r.kind === "human" && r.participant
          ? { kind: "human", id: r.participant }
          : r.kind === "bot"
            ? { kind: "bot" }
            : { kind: "open" },
    }));
  }
}
