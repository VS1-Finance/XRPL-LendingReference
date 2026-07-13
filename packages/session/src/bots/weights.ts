import { SeededRandom, seededStream } from "@lending/shared";
import type { Session } from "../session.js";
import { keyOf } from "../seat.js";
import type { BotVariant } from "./variant.js";
import { overpay, defaulter, repayEarly, repayLate } from "./borrower-variants.js";
import { repayOnTime } from "./variants.js";
import { depositAndHold } from "./variants.js";
import { depositWithdrawCycle, topUp } from "./depositor-variants.js";
import { brokerOwner } from "./owner-variants.js";
import type { VariantAssignment } from "./assignment.js";

// Relative weights that bias how variants are drawn for each seat of a pool. Weights need not sum to
// one; a weight of zero excludes a behaviour.
export interface BotWeights {
  seed: string;
  borrowerWeights: { onTime: number; late: number; early: number; overpay: number; default: number };
  depositorWeights: { hold: number; churn: number; topUp: number };
}

// Bot-behaviour presets selected at session creation. Each biases the variant mix toward a story:
// "calm" borrowers pay on time and depositors hold; "mixed" spreads across behaviours; and
// "defaults" weights borrowers toward late payment and default to exercise the loss path. The seed is
// carried through from the base weights so a scenario stays reproducible.
export function scenarioWeights(scenario: string, seed: string): BotWeights {
  switch (scenario) {
    case "calm":
      return {
        seed,
        borrowerWeights: { onTime: 8, late: 1, early: 2, overpay: 1, default: 0 },
        depositorWeights: { hold: 6, churn: 1, topUp: 2 },
      };
    case "defaults":
      return {
        seed,
        borrowerWeights: { onTime: 1, late: 3, early: 0, overpay: 0, default: 5 },
        depositorWeights: { hold: 3, churn: 2, topUp: 1 },
      };
    case "mixed":
    default:
      return {
        seed,
        borrowerWeights: { onTime: 5, late: 1, early: 1, overpay: 1, default: 2 },
        depositorWeights: { hold: 3, churn: 1, topUp: 1 },
      };
  }
}

// Assign each bot-eligible seat a variant drawn from the weighted set for its role, using a seeded
// generator so the same seed and pool produce the same assignment every run. This is what makes a
// weighted scenario (for example defaults-heavy) both configurable and reproducible.
export function assignWeighted(session: Session, weights: BotWeights): VariantAssignment {
  const rng = seededStream(weights.seed, "variant-assignment");
  const assignment: VariantAssignment = new Map();

  for (const seat of session.seats.values()) {
    const choice = pickForRole(seat.role, weights, rng);
    if (choice) assignment.set(keyOf(seat), choice);
  }
  return assignment;
}

function pickForRole(role: string, weights: BotWeights, rng: SeededRandom): BotVariant | undefined {
  if (role === "borrower") {
    const w = weights.borrowerWeights;
    return rng.weighted([
      { value: repayOnTime(), weight: w.onTime },
      { value: repayLate(), weight: w.late },
      { value: repayEarly(), weight: w.early },
      { value: overpay(), weight: w.overpay },
      { value: defaulter(), weight: w.default },
    ]);
  }
  if (role === "depositor") {
    const w = weights.depositorWeights;
    return rng.weighted([
      { value: depositAndHold(), weight: w.hold },
      { value: depositWithdrawCycle(), weight: w.churn },
      { value: topUp(), weight: w.topUp },
    ]);
  }
  // The owner seat originates loans and enforces defaults on delinquent ones; there is one combined
  // behaviour, not a weighted set.
  if (role === "owner") return brokerOwner();
  return undefined;
}
