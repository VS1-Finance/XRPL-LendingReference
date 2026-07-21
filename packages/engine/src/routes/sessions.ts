import type { FastifyInstance } from "fastify";
import type { SessionService } from "../session-service.js";
import { readSessionState } from "../state-service.js";

// The body a session-creation request accepts: a label, pool sizes, and optional overrides onto the
// base config (asset, broker rates, cover and debt limits). Anything omitted keeps the base value.
interface ProvisionBody {
  label?: string;
  depositors?: number;
  borrowers?: number;
  asset?: string;
  coverRatePercent?: number;
  liquidationRatePercent?: number;
  managementFeePercent?: number;
  coverAmount?: string;
  debtMaximum?: string;
  scenario?: string;
  // Whether the vault is permissioned (domain-gated, default) or public (open). false → public.
  permissioned?: boolean;
}

// Session endpoints: create a session (provision a fresh environment), list sessions, and fetch one
// session's detail (its seats and who holds each).
export function registerSessionRoutes(app: FastifyInstance, sessions: SessionService): void {
  // Create a session. An optional label makes it recognizable; provisioning runs on the ledger, so
  // this call takes as long as a full environment provision.
  app.post<{ Body: ProvisionBody }>("/sessions", async (request, reply) => {
    const summary = await sessions.create(request.body ?? {});
    return reply.code(201).send(summary);
  });

  // Create a session while streaming provisioning progress as Server-Sent Events. Each ledger step
  // emits a `step` event as it settles (action, result, transaction hash); provisioning ends with a
  // `done` event carrying the session summary, or an `error` event if it fails. This lets a client
  // show the environment being built step by step rather than waiting for one blocking response.
  app.post<{ Body: ProvisionBody }>("/sessions/stream", async (request, reply) => {
    const body = request.body ?? {};

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Mirror the CORS allowance onto the raw stream, which bypasses the plugin's reply decoration.
      "access-control-allow-origin": request.headers.origin ?? "*",
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const summary = await sessions.create({ ...body, onStep: (record) => send("step", record) });
      send("done", summary);
    } catch (err) {
      send("error", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
  });

  // List all live sessions with their seat maps and open seats.
  app.get("/sessions", async () => sessions.list());

  // One session's detail.
  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const summary = sessions.summaryOf(request.params.id);
    if (!summary) return reply.code(404).send({ error: `no session ${request.params.id}` });
    return summary;
  });

  // A session's current on-chain state — vault, broker, loans, and seat occupancy — read live from
  // the validated ledger. This is what a front end polls to watch the session evolve.
  app.get<{ Params: { id: string } }>("/sessions/:id/state", async (request, reply) => {
    const session = sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: `no session ${request.params.id}` });
    return readSessionState(session);
  });

  // A session's action log — every human, bot, and system action with its ledger result, oldest
  // first. Raw params are returned so the client can format a human-readable detail.
  app.get<{ Params: { id: string } }>("/sessions/:id/log", async (request, reply) => {
    if (!sessions.get(request.params.id)) return reply.code(404).send({ error: `no session ${request.params.id}` });
    return sessions.log(request.params.id);
  });
}
