import { describe, it, expect } from "vitest";
import { phaseGateError, ActionError } from "./action-service.js";

describe("phaseGateError", () => {
  it("blocks deposit outside subscription", () => {
    expect(phaseGateError("deposit", "investment")).toBeInstanceOf(ActionError);
    expect(phaseGateError("deposit", "redemption")?.status).toBe(409);
    expect(phaseGateError("deposit", "subscription")).toBeUndefined();
  });
  it("blocks originate/request-loan outside investment", () => {
    expect(phaseGateError("originate", "subscription")?.status).toBe(409);
    expect(phaseGateError("request-loan", "redemption")).toBeInstanceOf(ActionError);
    expect(phaseGateError("originate", "investment")).toBeUndefined();
  });
  it("blocks withdraw only in investment", () => {
    expect(phaseGateError("withdraw", "investment")?.status).toBe(409);
    expect(phaseGateError("withdraw", "subscription")).toBeUndefined();
    expect(phaseGateError("withdraw", "redemption")).toBeUndefined();
  });
  it("never blocks repay or manage-loan", () => {
    for (const p of ["subscription", "investment", "redemption"] as const) {
      expect(phaseGateError("repay", p)).toBeUndefined();
      expect(phaseGateError("manage-loan", p)).toBeUndefined();
    }
  });
  it("does not gate when phase is null (non-closed-ended vault)", () => {
    expect(phaseGateError("deposit", null)).toBeUndefined();
    expect(phaseGateError("originate", null)).toBeUndefined();
  });
});
