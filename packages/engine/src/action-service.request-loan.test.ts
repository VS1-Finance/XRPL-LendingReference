import { describe, it, expect } from "vitest";
import { requestLoan, ActionError } from "./action-service.js";
import type { Session } from "@lending/session";
import type { Seat, Occupant } from "@lending/session";

// Guard-path unit tests for requestLoan. These cover the authorization contract that runs BEFORE any
// ledger call, so no real client is needed — the fake client throws if the guards are wrong and let a
// request through to it. The happy path (bilateral sign + submit) is covered by live Devnet verification.

function seat(role: Seat["role"], index: number, occupant: Occupant): Seat {
  return { role, index, occupant, address: `r${role}${index}`, signer: {} as Seat["signer"] };
}

// A session whose `client.request` returns a configurable loan-object list, so the one-loan guard can
// be exercised. Any other client call is a test failure (a guard should have rejected first).
function fakeSession(seats: Seat[], loanObjects: unknown[] = []): Session {
  const map = new Map<string, Seat>();
  for (const s of seats) map.set(`${s.role}:${s.index}`, s);
  const client = {
    request: async (req: { command: string }) => {
      if (req.command === "account_objects") return { result: { account_objects: loanObjects } };
      throw new Error(`unexpected client call: ${req.command}`);
    },
  };
  return {
    seed: "test-seed",
    seats: map,
    client,
    env: { objects: { brokerId: "B" } },
  } as unknown as Session;
}

async function expectActionError(fn: () => Promise<unknown>, status: number, messageMatch: RegExp): Promise<void> {
  await expect(fn()).rejects.toMatchObject({ name: "ActionError", status });
  await fn().catch((e) => {
    expect(e).toBeInstanceOf(ActionError);
    expect(e.message).toMatch(messageMatch);
  });
}

describe("requestLoan authorization guards", () => {
  it("404s when the named borrower seat does not exist", async () => {
    const s = fakeSession([seat("owner", 0, { kind: "bot" })]);
    await expectActionError(() => requestLoan(s, "borrower:9", { principal: "100" }, "alice"), 404, /no seat borrower:9/);
  });

  it("409s when the borrower seat is not held by the caller", async () => {
    const s = fakeSession([seat("borrower", 0, { kind: "bot" }), seat("owner", 0, { kind: "bot" })]);
    await expectActionError(() => requestLoan(s, "borrower:0", { principal: "100" }, "alice"), 409, /not held by alice/);
  });

  it("409s when a non-borrower seat is used to request a loan", async () => {
    const s = fakeSession([seat("depositor", 0, { kind: "human", id: "alice" }), seat("owner", 0, { kind: "bot" })]);
    await expectActionError(() => requestLoan(s, "depositor:0", { principal: "100" }, "alice"), 409, /only a borrower seat/);
  });

  it("404s when the session has no owner seat", async () => {
    const s = fakeSession([seat("borrower", 0, { kind: "human", id: "alice" })]);
    await expectActionError(() => requestLoan(s, "borrower:0", { principal: "100" }, "alice"), 404, /no owner seat/);
  });

  it("409s when the borrower already has an ACTIVE loan (payments remaining)", async () => {
    // The one-loan guard queries account_objects; a loan with payments still remaining means the borrower
    // is still borrowing. An active loan carries PaymentRemaining > 0 (and no defaulted flag).
    const s = fakeSession(
      [seat("borrower", 0, { kind: "human", id: "alice" }), seat("owner", 0, { kind: "bot" })],
      [{ LedgerEntryType: "Loan", PaymentRemaining: 3, Flags: 0 }],
    );
    await expectActionError(() => requestLoan(s, "borrower:0", { principal: "100" }, "alice"), 409, /already has an active loan/);
  });

  it("does NOT block when the borrower's only loan is fully repaid (closed husk)", async () => {
    // A fully-repaid loan leaves a closed Loan object whose balance fields (PaymentRemaining,
    // TotalValueOutstanding) have been dropped by the ledger. It must not count as active — otherwise a
    // borrower can never take a second loan after settling the first (the live bug this fixes). The guard
    // passes, so the request proceeds to the term check; a valid principal reaches the ledger sign step,
    // which the fake client does not implement — so we assert it gets PAST the one-loan guard, not a 409.
    const s = fakeSession(
      [seat("borrower", 0, { kind: "human", id: "alice" }), seat("owner", 0, { kind: "bot" })],
      [{ LedgerEntryType: "Loan" }], // closed husk: no PaymentRemaining
    );
    // It must not throw the one-loan 409. It will fail later (no signer in the fake), but NOT with 409.
    await expect(requestLoan(s, "borrower:0", { principal: "100" }, "alice")).rejects.not.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already has an active loan/),
    });
  });

  it("does NOT block when the borrower's only loan is defaulted", async () => {
    // A defaulted loan (lsfLoanDefaulted = 0x00010000) is no longer a live obligation and must not block
    // a new request either, even if PaymentRemaining is still nominally present.
    const s = fakeSession(
      [seat("borrower", 0, { kind: "human", id: "alice" }), seat("owner", 0, { kind: "bot" })],
      [{ LedgerEntryType: "Loan", PaymentRemaining: 2, Flags: 0x00010000 }],
    );
    await expect(requestLoan(s, "borrower:0", { principal: "100" }, "alice")).rejects.not.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already has an active loan/),
    });
  });

  it("400s on an invalid term before reaching the ledger", async () => {
    // paymentTotal is guarded as a positive integer; 0 (or any non-integer) must be a clean 400, not a
    // malformed transaction the ledger rejects opaquely. Runs after the one-loan check, before autofill.
    const s = fakeSession([seat("borrower", 0, { kind: "human", id: "alice" }), seat("owner", 0, { kind: "bot" })]);
    await expectActionError(() => requestLoan(s, "borrower:0", { principal: "100", paymentTotal: "0" }, "alice"), 400, /invalid term/);
    await expectActionError(() => requestLoan(s, "borrower:0", { principal: "100", paymentTotal: "2.5" }, "alice"), 400, /invalid term/);
  });
});
