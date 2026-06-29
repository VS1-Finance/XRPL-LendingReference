import type { Role } from "@lending/shared";
import type { Session } from "../session.js";
import { keyOf } from "../seat.js";
import type { BotVariant } from "./variant.js";

// Which variant each seat's bot runs, keyed by seat (e.g. "depositor:1"). A pool is heterogeneous:
// different seats of the same role may run different variants, so the assignment is per seat rather
// than per role.
export type VariantAssignment = Map<string, BotVariant>;

// Spread a set of variants across the seats of each role, round-robin by seat index. Given, say, two
// borrower variants and three borrower seats, seats 0 and 2 get the first variant and seat 1 the
// second — so a mixed pool falls out of the ordering without naming every seat. Seats whose role has
// no variant are left unassigned (their bot idles).
export function assignAutomatically(session: Session, variants: BotVariant[]): VariantAssignment {
  const byRole = new Map<Role, BotVariant[]>();
  for (const v of variants) {
    const list = byRole.get(v.role) ?? [];
    list.push(v);
    byRole.set(v.role, list);
  }

  const assignment: VariantAssignment = new Map();
  for (const seat of session.seats.values()) {
    const options = byRole.get(seat.role);
    if (!options || options.length === 0) continue;
    assignment.set(keyOf(seat), options[seat.index % options.length]!);
  }
  return assignment;
}
