import { describe, it, expect } from "vitest";
import { resolveLoanDefaults, ValidationError } from "./session-service.js";

describe("resolveLoanDefaults", () => {
  it("scales interest percent to the ledger integer", () => {
    expect(resolveLoanDefaults({ interestRatePercent: 8 }).interestRate).toBe(8000);
  });
  it("passes interval/grace/term through as integers", () => {
    expect(resolveLoanDefaults({ paymentInterval: 120, gracePeriod: 60, paymentTotal: 3 }))
      .toEqual({ paymentInterval: 120, gracePeriod: 60, paymentTotal: 3 });
  });
  it("returns an empty object when nothing is supplied", () => {
    expect(resolveLoanDefaults({})).toEqual({});
  });
  it("treats blank strings as absent (form sends '')", () => {
    expect(resolveLoanDefaults({ interestRatePercent: "", paymentInterval: "" })).toEqual({});
  });
  it("rejects out-of-range rate", () => {
    expect(() => resolveLoanDefaults({ interestRatePercent: 150 })).toThrow(ValidationError);
  });
  it("rejects interval below 60", () => {
    expect(() => resolveLoanDefaults({ paymentInterval: 30 })).toThrow(/paymentInterval/);
  });
  it("rejects grace greater than interval when both are defaults", () => {
    expect(() => resolveLoanDefaults({ paymentInterval: 60, gracePeriod: 120 })).toThrow(/exceed/);
  });
  it("rejects a non-positive or non-integer term", () => {
    expect(() => resolveLoanDefaults({ paymentTotal: 0 })).toThrow(ValidationError);
    expect(() => resolveLoanDefaults({ paymentTotal: 2.5 })).toThrow(ValidationError);
  });
  it("rejects a non-numeric value", () => {
    expect(() => resolveLoanDefaults({ interestRatePercent: "abc" })).toThrow(/must be a number/);
  });
});
