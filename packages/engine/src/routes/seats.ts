import type { FastifyInstance, FastifyReply } from "fastify";
import { SeatOccupancyError } from "@lending/session";
import type { SessionService } from "../session-service.js";

// Seat endpoints: a participant claims a seat to take over that role, and releases it back to open
// where a bot fills it again. Occupancy is written through to the store so it survives a restart.
export function registerSeatRoutes(app: FastifyInstance, sessions: SessionService): void {
  // Claim a seat for a participant. Rejected if a different participant already holds it.
  app.post<{ Params: { id: string; seat: string }; Body: { participant: string } }>(
    "/sessions/:id/seats/:seat/claim",
    async (request, reply) => {
      const participant = request.body?.participant;
      if (!participant) return reply.code(400).send({ error: "participant is required" });
      if (!sessions.get(request.params.id)) return reply.code(404).send({ error: `no session ${request.params.id}` });
      try {
        await sessions.claimSeat(request.params.id, request.params.seat, participant);
      } catch (err) {
        return seatError(reply, err);
      }
      return sessions.summaryOf(request.params.id);
    },
  );

  // Release a seat a participant holds, back to open.
  app.post<{ Params: { id: string; seat: string }; Body: { participant: string } }>(
    "/sessions/:id/seats/:seat/release",
    async (request, reply) => {
      const participant = request.body?.participant;
      if (!participant) return reply.code(400).send({ error: "participant is required" });
      if (!sessions.get(request.params.id)) return reply.code(404).send({ error: `no session ${request.params.id}` });
      try {
        await sessions.releaseSeat(request.params.id, request.params.seat, participant);
      } catch (err) {
        return seatError(reply, err);
      }
      return sessions.summaryOf(request.params.id);
    },
  );
}

function seatError(reply: FastifyReply, err: unknown) {
  if (err instanceof SeatOccupancyError) return reply.code(409).send({ error: err.message });
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(400).send({ error: message });
}
