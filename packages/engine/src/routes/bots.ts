import type { FastifyInstance } from "fastify";
import type { SessionService } from "../session-service.js";
import type { BotService } from "../bot-service.js";

// Bot control: start or stop the bots for a session. While running, the scheduler drives every seat
// no human holds; claiming a seat stands its bot down and releasing it lets the bot resume.
export function registerBotRoutes(app: FastifyInstance, sessions: SessionService, bots: BotService): void {
  app.post<{ Params: { id: string }; Body: { intervalSeconds?: number } }>(
    "/sessions/:id/bots/start",
    async (request, reply) => {
      const session = sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: `no session ${request.params.id}` });
      bots.start(session, Number(request.body?.intervalSeconds ?? 15));
      return { setupId: session.setupId, bots: "running" };
    },
  );

  app.post<{ Params: { id: string } }>("/sessions/:id/bots/stop", async (request, reply) => {
    if (!sessions.get(request.params.id)) return reply.code(404).send({ error: `no session ${request.params.id}` });
    bots.stop(request.params.id);
    return { setupId: request.params.id, bots: "stopped" };
  });
}
