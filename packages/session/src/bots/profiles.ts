import type { BotVariant } from "./variant.js";
import { depositAndHold, repayOnTime } from "./variants.js";
import { defaulter, overpay, repayLate } from "./borrower-variants.js";
import { depositWithdrawCycle } from "./depositor-variants.js";

// A named set of variants a bot pool runs. The scheduler spreads them across seats automatically, so
// a profile with several variants per role produces a heterogeneous pool.
export type ProfileName = "happy" | "adversarial";

const PROFILES: Record<ProfileName, () => BotVariant[]> = {
  // Every seat behaves well: depositors hold, borrowers pay on time.
  happy: () => [depositAndHold(), repayOnTime()],
  // A mixed pool: some depositors hold and some churn; borrowers span on-time, late, overpaying and
  // defaulting. Spread across seats by index, this exercises the full behavioural range at once.
  adversarial: () => [
    depositAndHold(),
    depositWithdrawCycle(),
    repayOnTime(),
    repayLate(),
    overpay(),
    defaulter(),
  ],
};

export function profileVariants(name: ProfileName): BotVariant[] {
  return PROFILES[name]();
}

export function isProfileName(value: string): value is ProfileName {
  return value === "happy" || value === "adversarial";
}
