import { describe, it, expect } from "vitest";
import { closedEndedVaultWindow } from "./client.js";
import type { Client } from "xrpl";

const NOW = 800000000; // ripple-epoch seconds
const SUBSCRIPTION_LEAD_SECONDS = 300;
const TEN_YEARS_SECONDS = 10 * 365 * 24 * 3600;
const fakeClient = { request: async () => ({ result: { ledger: { close_time: NOW } } }) } as unknown as Client;

describe("closedEndedVaultWindow", () => {
  it("returns a window whose gap is within [180s, 30 years) and is not already expired", async () => {
    const w = await closedEndedVaultWindow(fakeClient);
    const gap = w.redemptionDate - w.subscriptionDate;
    expect(gap).toBeGreaterThanOrEqual(180);
    expect(gap).toBeLessThan(946080000); // 30 years in seconds
    // subscriptionDate must be strictly in the future (leads `now` by SUBSCRIPTION_LEAD_SECONDS) so it
    // is not already expired by the time the tx validates (rippled's Inclusive hasExpired check).
    expect(w.subscriptionDate).toBeGreaterThan(NOW);
    expect(w.subscriptionDate).toBe(NOW + SUBSCRIPTION_LEAD_SECONDS);
    // redemptionDate is anchored exactly TEN_YEARS_SECONDS after subscriptionDate, not independently
    // off `now`, so the gap invariant holds exactly regardless of the lead.
    expect(w.redemptionDate).toBe(w.subscriptionDate + TEN_YEARS_SECONDS);
    expect(w.redemptionDate).toBeGreaterThan(NOW); // redemption in the future
  });
});
