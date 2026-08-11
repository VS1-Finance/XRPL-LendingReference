import { describe, it, expect } from "vitest";
import { assignWeighted, scenarioWeights } from "./weights.js";
import type { Session } from "../session.js";
import type { Seat } from "../seat.js";

// The bot seed's whole job is to make variant assignment reproducible: the same seed (with the same
// scenario and seat set) must map each seat to the same variant, and a different seed must change the
// mapping. These tests pin both directions so a regression that ignores the seed is caught here.

function seat(role: Seat["role"], index: number): Seat {
  return { role, index, address: `r${role}${index}`, signer: {} as Seat["signer"], occupant: { kind: "bot" } };
}

// A minimal Session stub: assignWeighted only reads `seats`, iterating its values in insertion order.
function sessionWith(seats: Seat[]): Session {
  const map = new Map<string, Seat>();
  for (const s of seats) map.set(`${s.role}:${s.index}`, s);
  return { seats: map } as unknown as Session;
}

// A pool with several borrowers and depositors so the assignment has real choices to make (the owner
// seat takes no rng draw, so include the pooled roles that do).
const POOL = [
  seat("owner", 0),
  seat("depositor", 0),
  seat("depositor", 1),
  seat("borrower", 0),
  seat("borrower", 1),
];

// Compare two assignments by variant name so the maps are equatable.
function names(assignment: Map<string, { name: string }>): Record<string, string> {
  return Object.fromEntries([...assignment.entries()].map(([k, v]) => [k, v.name]));
}

describe("assignWeighted determinism", () => {
  it("is identical for the same seed + scenario + seat set", () => {
    const s = sessionWith(POOL);
    const a = names(assignWeighted(s, scenarioWeights("mixed", "seed-abc")));
    const b = names(assignWeighted(s, scenarioWeights("mixed", "seed-abc")));
    expect(a).toEqual(b);
    // Sanity: it actually assigned the pooled seats, not an empty map.
    expect(Object.keys(a).length).toBeGreaterThan(0);
  });

  it("differs for a different seed (the seed is wired, not ignored)", () => {
    const s = sessionWith(POOL);
    const a = names(assignWeighted(s, scenarioWeights("mixed", "seed-abc")));
    const b = names(assignWeighted(s, scenarioWeights("mixed", "seed-xyz")));
    // At least one seat must land on a different variant, or the seed has no effect.
    expect(a).not.toEqual(b);
  });

  it("is stable across repeated calls (not order- or state-dependent)", () => {
    const s = sessionWith(POOL);
    const first = names(assignWeighted(s, scenarioWeights("mixed", "seed-repeat")));
    for (let i = 0; i < 5; i++) {
      expect(names(assignWeighted(s, scenarioWeights("mixed", "seed-repeat")))).toEqual(first);
    }
  });
});
