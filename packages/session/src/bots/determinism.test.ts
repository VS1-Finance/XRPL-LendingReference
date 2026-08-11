import { describe, it, expect } from "vitest";
import { assignWeighted, scenarioWeights } from "./weights.js";
import type { Session } from "../session.js";
import type { Seat } from "../seat.js";

// The decision-purity property: the amount an originator/depositor computes is Math.min(fixedValue,
// floor(headroom)) — a pure function of observed headroom. This is a SPEC ANCHOR, not a test of an
// extracted shared helper: the rule is inline (not factored out) in three call sites, verbatim as
// `Math.min(Number(<fixedValue>), Math.floor(headroom)).toString()`:
//   - packages/session/src/bots/owner-variants.ts:36       (loan-originator principal)
//   - packages/session/src/bots/depositor-variants.ts:23   (deposit-withdraw-cycle deposit amount)
//   - packages/session/src/bots/depositor-variants.ts:60   (top-up increment)
// (A fourth, packages/session/src/bots/variants.ts:19, uses the identical rule for depositAndHold.)
// We do not import these variants' tick() here because exercising the rule live requires a connected
// session/ledger (headroom is read from chain state) — see the live-on-Devnet check for that. This
// test instead pins the rule's mathematical property (purity, floor, cap) so a change to any of the
// four sites that departs from Math.min(fixed, floor(headroom)) is a deliberate, visible diff against
// this comment and these citations, not a silent behavior change.
function amountRule(fixedValue: number, headroom: number): string {
  return Math.min(fixedValue, Math.floor(headroom)).toString();
}

describe("bot decision purity", () => {
  it("amount is a deterministic function of (fixedValue, headroom) — spec anchor for the inline rule cited above", () => {
    for (const [v, h] of [[20000, 500.7], [5000, 5000], [100, 0.4], [300, 12345.9]] as const) {
      const a = amountRule(v, h);
      const b = amountRule(v, h);
      expect(a).toBe(b); // same inputs → same output, always
    }
    expect(amountRule(20000, 500.7)).toBe("500");   // floors headroom
    expect(amountRule(300, 12345.9)).toBe("300");   // caps at fixedValue
    expect(amountRule(100, 0.4)).toBe("0");          // sub-1 headroom → 0 (caller treats as stand-down)
  });

  it("variant assignment is fully seed-determined (behavior map is reproducible)", () => {
    const seats: Seat[] = [
      { role: "owner", index: 0, address: "rO", signer: {} as Seat["signer"], occupant: { kind: "bot" } },
      { role: "depositor", index: 0, address: "rD0", signer: {} as Seat["signer"], occupant: { kind: "bot" } },
      { role: "depositor", index: 1, address: "rD1", signer: {} as Seat["signer"], occupant: { kind: "bot" } },
      { role: "borrower", index: 0, address: "rB0", signer: {} as Seat["signer"], occupant: { kind: "bot" } },
      { role: "borrower", index: 1, address: "rB1", signer: {} as Seat["signer"], occupant: { kind: "bot" } },
    ];
    const session = { seats: new Map(seats.map((s) => [`${s.role}:${s.index}`, s])) } as unknown as Session;
    const run = () => [...assignWeighted(session, scenarioWeights("mixed", "seed-fixed")).entries()]
      .map(([k, v]) => `${k}=${v.name}`).sort().join(",");
    const first = run();
    for (let i = 0; i < 10; i++) expect(run()).toBe(first); // identical behavior map every time
  });
});
