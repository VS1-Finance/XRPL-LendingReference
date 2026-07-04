import type { FastifyInstance } from "fastify";
import type { SessionService } from "../session-service.js";

// Session endpoints: create a session (provision a fresh environment), list sessions, and fetch one
// session's detail (its seats and who holds each).
export function registerSessionRoutes(app: FastifyInstance, sessions: SessionService): void {
  // Create a session. An optional label makes it recognizable; provisioning runs on the ledger, so
  // this call takes as long as a full environment provision.
  app.post<{ Body: { label?: string } }>("/sessions", async (request, reply) => {
    const label = request.body?.label;
    const summary = await sessions.create(label);
    return reply.code(201).send(summary);
  });

  // List all live sessions with their seat maps and open seats.
  app.get("/sessions", async () => sessions.list());

  // One session's detail.
  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const summary = sessions.summaryOf(request.params.id);
    if (!summary) return reply.code(404).send({ error: `no session ${request.params.id}` });
    return summary;
  });
}
