import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./schema.js";

// A minimal valid config the vault-window cases layer onto. Mirrors config.example.json's required
// shape; only the fields ConfigSchema requires are set.
const base = {
  seed: "test-seed-with-enough-entropy",
  network: "devnet",
  setupId: "session-test",
  asset: { currency: "XRP" },
  coverRateMinimum: 100000,
  coverRateLiquidation: 100000,
  managementFeeRate: 0,
  coverAmount: "20000",
  debtMaximum: "100000",
  pool: { depositors: 1, borrowers: 1 },
};

describe("ConfigSchema subscription/investment windows", () => {
  it("defaults subscriptionWindowSeconds to 180 and investmentWindowSeconds to 31536000 when omitted", () => {
    const r = ConfigSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.subscriptionWindowSeconds).toBe(180);
      expect(r.data.investmentWindowSeconds).toBe(31536000);
    }
  });

  it("accepts an explicit valid pair (20 / 3600)", () => {
    const r = ConfigSchema.safeParse({ ...base, subscriptionWindowSeconds: 20, investmentWindowSeconds: 3600 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.subscriptionWindowSeconds).toBe(20);
      expect(r.data.investmentWindowSeconds).toBe(3600);
    }
  });

  it("rejects investmentWindowSeconds below the ledger's kMinInvestmentPeriod (100 < 180)", () => {
    expect(ConfigSchema.safeParse({ ...base, investmentWindowSeconds: 100 }).success).toBe(false);
  });

  it("rejects investmentWindowSeconds at kMaxInvestmentPeriod (946708560, the exclusive bound)", () => {
    expect(ConfigSchema.safeParse({ ...base, investmentWindowSeconds: 946708560 }).success).toBe(false);
  });

  it("accepts investmentWindowSeconds one below kMaxInvestmentPeriod (946708559)", () => {
    expect(ConfigSchema.safeParse({ ...base, investmentWindowSeconds: 946708559 }).success).toBe(true);
  });

  it("rejects subscriptionWindowSeconds of 0", () => {
    expect(ConfigSchema.safeParse({ ...base, subscriptionWindowSeconds: 0 }).success).toBe(false);
  });

  it("rejects a non-integer subscriptionWindowSeconds", () => {
    expect(ConfigSchema.safeParse({ ...base, subscriptionWindowSeconds: 1.5 }).success).toBe(false);
  });
});
