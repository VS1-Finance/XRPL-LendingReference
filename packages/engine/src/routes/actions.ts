import type { FastifyInstance, FastifyReply } from "fastify";
import type { SessionService } from "../session-service.js";
import { ActionError, dispatchAction, originate, requestLoan, type ActionRequest } from "../action-service.js";

// The single action endpoint. Every human action against a seat — deposit, withdraw, repay,
// originate — arrives here; the engine confirms the seat is held by the requesting participant,
// builds the transaction, and submits it under the seat's identity.
export function registerActionRoutes(app: FastifyInstance, sessions: SessionService): void {
  app.post<{ Params: { id: string }; Body: ActionRequest & { participant: string } }>(
    "/sessions/:id/actions",
    async (request, reply) => {
      const session = sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: `no session ${request.params.id}` });

      const { participant, seat, action, params } = request.body ?? {};
      if (!participant) return reply.code(400).send({ error: "participant is required" });
      if (!seat || !action) return reply.code(400).send({ error: "seat and action are required" });

      // Fill blank loan-term fields from the session's defaults (per-origination values win). The engine
      // reads interestRate/interval/grace/paymentTotal; map the stored default keys to those param names.
      const withLoanDefaults = (p: Record<string, string>): Record<string, string> => {
        const d = sessions.loanDefaultsFor(request.params.id);
        if (!d) return p;
        const merged = { ...p };
        if ((merged.interestRate ?? "") === "" && d.interestRate !== undefined) merged.interestRate = String(d.interestRate);
        if ((merged.interval ?? "") === "" && d.paymentInterval !== undefined) merged.interval = String(d.paymentInterval);
        if ((merged.grace ?? "") === "" && d.gracePeriod !== undefined) merged.grace = String(d.gracePeriod);
        if ((merged.paymentTotal ?? "") === "" && d.paymentTotal !== undefined) merged.paymentTotal = String(d.paymentTotal);
        return merged;
      };

      try {
        // Origination is bilateral and takes its own path (owner-initiated, or borrower-initiated via
        // request-loan); everything else is a single-signer submit.
        const result =
          action === "originate"
            ? await originate(session, seat, withLoanDefaults(params ?? {}), participant)
            : action === "request-loan"
              ? await requestLoan(session, seat, withLoanDefaults(params ?? {}), participant)
              : await dispatchAction(session, { seat, action, ...(params ? { params } : {}) }, participant);

        // Record the human action in the session log, whatever its ledger result — a rejection is as
        // much a part of the record as a success.
        const role = session.seats.get(seat)?.role ?? seat.split(":")[0] ?? seat;
        await sessions.recordAction(request.params.id, {
          actor: seat,
          role,
          by: "human",
          action,
          code: result.code,
          ...(result.hash ? { hash: result.hash } : {}),
          ...(params ? { params } : {}),
        });
        return result;
      } catch (err) {
        return actionError(reply, err);
      }
    },
  );
}

function actionError(reply: FastifyReply, err: unknown) {
  if (err instanceof ActionError) return reply.code(err.status).send({ error: err.message });
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(500).send({ error: message });
}
