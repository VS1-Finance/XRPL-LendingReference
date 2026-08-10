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

  it("409s when the borrower already has an active loan", async () => {
    // The one-loan guard queries account_objects; a non-empty loan list means "already borrowing".
    const s = fakeSession(
      [seat("borrower", 0, { kind: "human", id: "alice" }), seat("owner", 0, { kind: "bot" })],
      [{ LedgerEntryType: "Loan" }],
    );
    await expectActionError(() => requestLoan(s, "borrower:0", { principal: "100" }, "alice"), 409, /already has an active loan/);
  });
});
