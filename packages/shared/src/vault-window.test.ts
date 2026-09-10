import { describe, it, expect } from "vitest";
import { closedEndedVaultWindow } from "./client.js";
import type { Client } from "xrpl";

const NOW = 800000000; // ripple-epoch seconds
const fakeClient = { request: async () => ({ result: { ledger: { close_time: NOW } } }) } as unknown as Client;

describe("closedEndedVaultWindow", () => {
  it("returns a window whose gap is within [180s, 30 years) and is not already expired", async () => {
    const w = await closedEndedVaultWindow(fakeClient);
    const gap = w.redemptionDate - w.subscriptionDate;
    expect(gap).toBeGreaterThanOrEqual(180);
    expect(gap).toBeLessThan(946080000); // 30 years in seconds
    expect(w.subscriptionDate).toBeLessThanOrEqual(NOW); // subscription open now, not future-expired
    expect(w.redemptionDate).toBeGreaterThan(NOW); // redemption in the future
  });
});
