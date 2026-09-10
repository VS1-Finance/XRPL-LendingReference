import { describe, it, expect } from "vitest";
import { closedEndedVaultWindow } from "./client.js";
import type { Client } from "xrpl";

const NOW = 800000000; // ripple-epoch seconds
const DEFAULT_SUBSCRIPTION_WINDOW_SECONDS = 180;
const DEFAULT_INVESTMENT_WINDOW_SECONDS = 31536000; // 1 year
const fakeClient = { request: async () => ({ result: { ledger: { close_time: NOW } } }) } as unknown as Client;

describe("closedEndedVaultWindow", () => {
  it("returns a window whose gap is within [180s, 30 years) and is not already expired", async () => {
    const w = await closedEndedVaultWindow(fakeClient);
    const gap = w.redemptionDate - w.subscriptionDate;
    expect(gap).toBeGreaterThanOrEqual(180);
    expect(gap).toBeLessThan(946708560); // kMaxInvestmentPeriod = std::chrono::years{30} (365.2425-day years)
    // subscriptionDate must be strictly in the future (leads `now` by the subscription window) so it
    // is not already expired by the time the tx validates (rippled's Inclusive hasExpired check).
    expect(w.subscriptionDate).toBeGreaterThan(NOW);
    expect(w.subscriptionDate).toBe(NOW + DEFAULT_SUBSCRIPTION_WINDOW_SECONDS);
    // redemptionDate is anchored exactly the investment window after subscriptionDate, not independently
    // off `now`, so the gap invariant holds exactly regardless of the subscription window.
    expect(w.redemptionDate).toBe(w.subscriptionDate + DEFAULT_INVESTMENT_WINDOW_SECONDS);
    expect(w.redemptionDate).toBeGreaterThan(NOW); // redemption in the future
  });

  it("honors explicit subscriptionWindowSeconds and investmentWindowSeconds opts", async () => {
    const w = await closedEndedVaultWindow(fakeClient, { subscriptionWindowSeconds: 20, investmentWindowSeconds: 3600 });
    expect(w.subscriptionDate).toBe(NOW + 20);
    expect(w.redemptionDate).toBe(NOW + 20 + 3600);
  });
});
