import { describe, it, expect } from "vitest";
import { loanPayFlags, ActionError } from "./action-service.js";

// loanPayFlags maps a repay request's optional paymentType to the single LoanPay flag the ledger needs
// for that behavior. The ledger permits at most one of these flags per LoanPay; the wrong flag (or its
// absence) is exactly what made the bot variants fail in the Foundation review — an overpayment without
// tfLoanOverpayment → tecNO_PERMISSION, a late payment without tfLoanLatePayment → tecEXPIRED.

describe("loanPayFlags", () => {
  it("maps each payment type to its exact XLS-66 LoanPay flag", () => {
    expect(loanPayFlags("overpayment")).toBe(0x00010000); // tfLoanOverpayment = 65536
    expect(loanPayFlags("full")).toBe(0x00020000); // tfLoanFullPayment = 131072
    expect(loanPayFlags("late")).toBe(0x00040000); // tfLoanLatePayment = 262144
  });

  it("returns undefined for an omitted type — an ordinary on-schedule payment carries no flag", () => {
    expect(loanPayFlags(undefined)).toBeUndefined();
    expect(loanPayFlags("")).toBeUndefined();
  });

  it("rejects an unknown payment type with a 400 ActionError, not a silent no-flag", () => {
    // A typo like "overpay" (vs "overpayment") must be a clean client error, not a payment that silently
    // drops the flag and then fails opaquely on-ledger.
    expect(() => loanPayFlags("overpay")).toThrow(ActionError);
    expect(() => loanPayFlags("early")).toThrow(/unknown paymentType early/);
    try {
      loanPayFlags("bogus");
    } catch (e) {
      expect((e as ActionError).status).toBe(400);
    }
  });
});
