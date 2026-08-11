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

  it("produces more than one distinct assignment across many seeds (the seed is wired, not ignored)", () => {
    // A single seed pair could collide by chance; sweep many real-shaped seeds and require genuine
    // variety, so a regression that ignores the seed (every run identical) fails here.
    const s = sessionWith(POOL);
    const distinct = new Set<string>();
    for (let i = 0; i < 50; i++) {
      distinct.add(JSON.stringify(names(assignWeighted(s, scenarioWeights("mixed", `seed-${i.toString(16).padStart(8, "0")}`)))));
    }
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("varies at each rng-driven seat across seeds, but keeps the owner seed-independent", () => {
    // Stronger than "some assignment differs": every rng-driven seat (depositors, borrowers) must take
    // at least two variants across the sweep, or that seat ignores the seed. The owner draws no rng, so
    // it must stay on the single "broker-owner" variant regardless of seed — assert that separately.
    const s = sessionWith(POOL);
    const perSeat: Record<string, Set<string>> = {};
    for (let i = 0; i < 60; i++) {
      const a = names(assignWeighted(s, scenarioWeights("mixed", `seed-${i.toString(16).padStart(8, "0")}`)));
      for (const [seatKey, variant] of Object.entries(a)) (perSeat[seatKey] ??= new Set()).add(variant);
    }
    for (const [seatKey, variants] of Object.entries(perSeat)) {
      if (seatKey.startsWith("owner:")) {
        expect(variants.size, `owner should be seed-independent but took ${[...variants]}`).toBe(1);
      } else {
        expect(variants.size, `seat ${seatKey} took only ${[...variants]}`).toBeGreaterThan(1);
      }
    }
    // The pooled seats must actually be present (guards against the map being owner-only).
    expect(Object.keys(perSeat).some((k) => k.startsWith("depositor:") || k.startsWith("borrower:"))).toBe(true);
  });

  it("is stable across repeated calls (not order- or state-dependent)", () => {
    const s = sessionWith(POOL);
    const first = names(assignWeighted(s, scenarioWeights("mixed", "seed-repeat")));
    for (let i = 0; i < 5; i++) {
      expect(names(assignWeighted(s, scenarioWeights("mixed", "seed-repeat")))).toEqual(first);
    }
  });
});

describe("assignWeighted with a changing seat set (add-participant path)", () => {
  it("keeps existing seats' variants when a new pooled seat is appended", () => {
    // routes/sessions.ts adds a participant by appending a seat, then restarts bots (re-running
    // assignWeighted over the whole grown set with the SAME seed). Existing seats must keep their
    // variants — otherwise a runtime add would silently rewrite who defaults vs repays. This holds
    // because non-pool roles draw no rng and the new seat lands at the tail of iteration.
    const before = sessionWith(POOL);
    const beforeNames = names(assignWeighted(before, scenarioWeights("mixed", "seed-add")));

    const grown = sessionWith([...POOL, seat("borrower", 2)]);
    const afterNames = names(assignWeighted(grown, scenarioWeights("mixed", "seed-add")));

    for (const key of Object.keys(beforeNames)) {
      expect(afterNames[key], `seat ${key} shifted on add`).toBe(beforeNames[key]);
    }
    // And the new seat got an assignment.
    expect(afterNames["borrower:2"]).toBeDefined();
  });
});

describe("assignWeighted on degenerate pools", () => {
  it("returns an empty assignment for an empty session (no throw)", () => {
    expect(assignWeighted(sessionWith([]), scenarioWeights("mixed", "seed-x")).size).toBe(0);
  });

  it("is seed-independent for a non-pooled-only pool (owner draws no rng)", () => {
    // The owner (and issuer/credentialIssuer) take no rng draw, so their assignment must not depend on
    // the seed — two different seeds give the identical result.
    const ownerOnly = sessionWith([seat("owner", 0)]);
    const a = names(assignWeighted(ownerOnly, scenarioWeights("mixed", "seed-a")));
    const b = names(assignWeighted(ownerOnly, scenarioWeights("mixed", "seed-b")));
    expect(a).toEqual(b);
  });
});
