import type { FastifyInstance, FastifyReply } from "fastify";
import { SeatOccupancyError } from "@lending/session";
import type { SessionService } from "../session-service.js";

// Seat endpoints: a participant claims a seat to take over that role, and releases it back to open
// where a bot fills it again. Occupancy is written through to the store so it survives a restart.
//
// Guard precedence is resource-first, matching the action route: unknown session → 404, unknown seat →
// 404, missing participant → 400, occupancy conflict → 409. (Deriving the seat here also lets an unknown
// seat return 404 rather than the 400 a bare registry error would produce.)
export function registerSeatRoutes(app: FastifyInstance, sessions: SessionService): void {
  // Claim a seat for a participant. Rejected if a different participant already holds it.
  app.post<{ Params: { id: string; seat: string }; Body: { participant: string } }>(
    "/sessions/:id/seats/:seat/claim",
    async (request, reply) => {
      const session = sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: `no session ${request.params.id}` });
      if (!session.seats.has(request.params.seat)) return reply.code(404).send({ error: `no seat ${request.params.seat}` });
      const participant = request.body?.participant;
      if (!participant) return reply.code(400).send({ error: "participant is required" });
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
      const session = sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: `no session ${request.params.id}` });
      if (!session.seats.has(request.params.seat)) return reply.code(404).send({ error: `no seat ${request.params.seat}` });
      const participant = request.body?.participant;
      if (!participant) return reply.code(400).send({ error: "participant is required" });
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
