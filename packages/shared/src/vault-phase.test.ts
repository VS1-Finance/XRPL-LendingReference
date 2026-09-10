import { describe, it, expect } from "vitest";
import { vaultPhase, secondsUntilNextPhase } from "./client.js";

const V = (sub: number, red: number) => ({ VaultKind: 1, SubscriptionDate: sub, RedemptionDate: red });

describe("vaultPhase", () => {
  it("is subscription while now <= SubscriptionDate (inclusive boundary)", () => {
    expect(vaultPhase(V(100, 1000), 50)).toBe("subscription");
    expect(vaultPhase(V(100, 1000), 100)).toBe("subscription"); // now == SubscriptionDate is still subscription
  });
  it("is investment strictly after SubscriptionDate and strictly before RedemptionDate", () => {
    expect(vaultPhase(V(100, 1000), 101)).toBe("investment");
    expect(vaultPhase(V(100, 1000), 999)).toBe("investment");
  });
  it("is redemption at AND after RedemptionDate (now == RedemptionDate is already redemption)", () => {
    expect(vaultPhase(V(100, 1000), 1000)).toBe("redemption"); // rippled: now >= red is redemption
    expect(vaultPhase(V(100, 1000), 1001)).toBe("redemption");
  });
  it("is null for a non-closed-ended vault or missing dates", () => {
    expect(vaultPhase({ VaultKind: 0, SubscriptionDate: 100, RedemptionDate: 1000 }, 50)).toBeNull();
    expect(vaultPhase({ VaultKind: 1 }, 50)).toBeNull();
  });
});

describe("secondsUntilNextPhase", () => {
  it("counts down to SubscriptionDate in subscription, to RedemptionDate in investment, null in redemption/none", () => {
    expect(secondsUntilNextPhase(V(100, 1000), 40)).toBe(60);
    expect(secondsUntilNextPhase(V(100, 1000), 400)).toBe(600);
    expect(secondsUntilNextPhase(V(100, 1000), 1001)).toBeNull();
    expect(secondsUntilNextPhase({ VaultKind: 0 }, 40)).toBeNull();
  });
});
