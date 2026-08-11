import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./schema.js";

// A minimal valid config the loanDefaults cases layer onto. Mirrors config.example.json's required
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

describe("ConfigSchema loanDefaults", () => {
  it("accepts a config with no loanDefaults block (omit path unchanged)", () => {
    expect(ConfigSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a valid loanDefaults block", () => {
    const r = ConfigSchema.safeParse({ ...base, loanDefaults: { interestRate: 8000, paymentInterval: 60, gracePeriod: 60, paymentTotal: 3 } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.loanDefaults?.interestRate).toBe(8000);
  });

  it("rejects an interestRate above 100000", () => {
    expect(ConfigSchema.safeParse({ ...base, loanDefaults: { interestRate: 100001 } }).success).toBe(false);
  });

  it("rejects a paymentInterval below 60", () => {
    expect(ConfigSchema.safeParse({ ...base, loanDefaults: { paymentInterval: 30 } }).success).toBe(false);
  });

  it("rejects gracePeriod greater than paymentInterval", () => {
    expect(ConfigSchema.safeParse({ ...base, loanDefaults: { paymentInterval: 60, gracePeriod: 120 } }).success).toBe(false);
  });

  it("rejects a non-positive paymentTotal", () => {
    expect(ConfigSchema.safeParse({ ...base, loanDefaults: { paymentTotal: 0 } }).success).toBe(false);
  });

  it("rejects an unknown key inside loanDefaults (strict)", () => {
    expect(ConfigSchema.safeParse({ ...base, loanDefaults: { bogus: 1 } }).success).toBe(false);
  });
});
