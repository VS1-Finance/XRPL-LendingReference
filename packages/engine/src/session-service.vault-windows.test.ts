import { describe, it, expect } from "vitest";
import { resolveVaultWindows, ValidationError } from "./session-service.js";

// resolveVaultWindows validates the untyped `subscriptionWindowSeconds`/`investmentWindowSeconds`
// request fields BEFORE any provisioning. create() assembles the per-session config by spreading the
// base config directly — never re-parsed through ConfigSchema (the same bypass the mptAssetScale
// finding uncovered) — so this helper is the only thing standing between a bad client value and a
// ledger-side rejection mid-provision. Every bad shape must be a clean 400 here, not a 500.

describe("resolveVaultWindows", () => {
  it("returns an empty object when both fields are absent, so the base config's values apply downstream", () => {
    expect(resolveVaultWindows({})).toEqual({});
    // null is an omitted field, not a wrong-typed value: fall through rather than 400.
    expect(resolveVaultWindows({ subscriptionWindowSeconds: null, investmentWindowSeconds: null })).toEqual({});
  });

  it("accepts a valid pair verbatim", () => {
    expect(resolveVaultWindows({ subscriptionWindowSeconds: 20, investmentWindowSeconds: 3600 })).toEqual({
      subscriptionWindowSeconds: 20,
      investmentWindowSeconds: 3600,
    });
  });

  it("accepts investmentWindowSeconds at its boundaries (180 and 946708559)", () => {
    expect(resolveVaultWindows({ investmentWindowSeconds: 180 })).toEqual({ investmentWindowSeconds: 180 });
    expect(resolveVaultWindows({ investmentWindowSeconds: 946708559 })).toEqual({ investmentWindowSeconds: 946708559 });
  });

  it("accepts subscriptionWindowSeconds at its boundary (1)", () => {
    expect(resolveVaultWindows({ subscriptionWindowSeconds: 1 })).toEqual({ subscriptionWindowSeconds: 1 });
  });

  it("rejects subscriptionWindowSeconds < 1", () => {
    expect(() => resolveVaultWindows({ subscriptionWindowSeconds: 0 })).toThrow(/subscriptionWindowSeconds must be >= 1/);
    expect(() => resolveVaultWindows({ subscriptionWindowSeconds: -5 })).toThrow(ValidationError);
  });

  it("rejects investmentWindowSeconds < 180", () => {
    expect(() => resolveVaultWindows({ investmentWindowSeconds: 179 })).toThrow(/investmentWindowSeconds must be >= 180/);
    expect(() => resolveVaultWindows({ investmentWindowSeconds: 100 })).toThrow(ValidationError);
  });

  it("rejects investmentWindowSeconds >= 946708560 (kMaxInvestmentPeriod)", () => {
    expect(() => resolveVaultWindows({ investmentWindowSeconds: 946708560 })).toThrow(/investmentWindowSeconds must be < 946708560/);
    expect(() => resolveVaultWindows({ investmentWindowSeconds: 1_000_000_000 })).toThrow(ValidationError);
  });

  it("rejects non-integers", () => {
    for (const bad of [2.5, NaN, Infinity, -Infinity]) {
      expect(() => resolveVaultWindows({ subscriptionWindowSeconds: bad })).toThrow(/subscriptionWindowSeconds must be an integer/);
      expect(() => resolveVaultWindows({ investmentWindowSeconds: bad })).toThrow(/investmentWindowSeconds must be an integer/);
    }
  });

  it("rejects non-number shapes a schema-less route can receive (string, array, object, boolean)", () => {
    for (const bad of ["180", ["180"], { v: 180 }, true] as unknown[]) {
      expect(() => resolveVaultWindows({ subscriptionWindowSeconds: bad })).toThrow(ValidationError);
      expect(() => resolveVaultWindows({ investmentWindowSeconds: bad })).toThrow(ValidationError);
    }
  });
});
