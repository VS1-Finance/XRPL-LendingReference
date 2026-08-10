import type { Role } from "@lending/shared";
import type { Signer } from "./signer.js";

// Who currently drives a seat. A seat is either open (nobody), filled by a bot, or claimed by a
// specific human. Occupancy is exclusive: at any instant a seat's account is driven by exactly one
// party, which preserves the one-account-one-signer rule on-chain.
export type Occupant =
  | { kind: "open" }
  | { kind: "bot" }
  | { kind: "human"; id: string };

// A seat is one role slot in a session, bound to a single on-chain account. The signer is how that
// account acts, regardless of who occupies the seat.
export interface Seat {
  role: Role;
  index: number;
  address: string;
  signer: Signer;
  occupant: Occupant;
}

// A stable key for addressing a seat within a session, e.g. "depositor:0".
export function seatKey(role: Role, index: number): string {
  return `${role}:${index}`;
}

export function keyOf(seat: Seat): string {
  return seatKey(seat.role, seat.index);
}

export class SeatOccupancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatOccupancyError";
  }
}

// A human claims an open (or bot-filled) seat. The seat's bot, if any, stands down on its next tick
// because the seat is no longer bot-occupied. A seat already held by a different human cannot be
// claimed.
export function claim(seat: Seat, humanId: string): void {
  if (seat.occupant.kind === "human" && seat.occupant.id !== humanId) {
    throw new SeatOccupancyError(`${keyOf(seat)} is already held by another participant`);
  }
  seat.occupant = { kind: "human", id: humanId };
}

// A human releases a seat they hold; it returns to open, where a bot may fill it again. Releasing a
// seat one does not hold is rejected.
export function release(seat: Seat, humanId: string): void {
  if (seat.occupant.kind !== "human" || seat.occupant.id !== humanId) {
    throw new SeatOccupancyError(`${keyOf(seat)} is not held by ${humanId}`);
  }
  seat.occupant = { kind: "open" };
}

// Assign a bot to an open seat. A seat a human holds is left untouched.
export function fillWithBot(seat: Seat): void {
  if (seat.occupant.kind === "open") seat.occupant = { kind: "bot" };
}

export function isBotDriven(seat: Seat): boolean {
  return seat.occupant.kind === "bot";
}

export function isOpen(seat: Seat): boolean {
  return seat.occupant.kind === "open";
}

export function isHumanHeld(seat: Seat): boolean {
  return seat.occupant.kind === "human";
}
