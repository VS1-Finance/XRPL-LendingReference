import type { Role } from "@lending/shared";
import type { Session } from "../session.js";
import type { Seat } from "../seat.js";

// The context a bot variant acts within: its own seat, the session it belongs to, and a logger.
export interface BotContext {
  session: Session;
  seat: Seat;
  log: (msg: string) => void;
}

// One behavioral variant for a role. On each scheduler tick, a bot occupying a seat asks its variant
// what to do next. Returning nothing means "nothing to do this tick". A variant is a pure strategy;
// it acts through the seat's signer and reads state from the session, so the same variant works for
// any seat of its role.
export interface BotVariant {
  role: Role;
  name: string;
  // Perform at most one step of the variant's behavior. Implementations should be idempotent enough
  // that a repeated tick does not double-act (e.g. check current state before depositing again).
  tick(ctx: BotContext): Promise<StepOutcome>;
}

export type StepOutcome =
  | { acted: false }
  | { acted: true; action: string; result: string; hash?: string };

export const idle: StepOutcome = { acted: false };
