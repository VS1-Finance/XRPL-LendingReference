import { describe, it, expect } from "vitest";
import { dispatchAction, ActionError } from "./action-service.js";
import type { Session } from "@lending/session";
import type { Seat, Occupant } from "@lending/session";
import type { SubmittableTransaction } from "xrpl";

// delete-loan removes a closed (fully-repaid) Loan object to free the borrower's reserve. It is
// owner-signed and single-signer, so it goes through dispatchAction like manage-loan — no bilateral
// path. It is not phase-gated: LoanDelete carries no phase restriction, so dispatchAction never reads
// the vault for it. The ledger enforces the only precondition (a loan with outstanding debt is
// rejected with tecHAS_OBLIGATIONS), so the engine just submits and returns whatever tec code comes
// back. These tests capture the submitted transaction to assert its exact shape.

// A seat whose signer records the last transaction it was asked to submit, so a test can inspect the
// transaction the action built.
function capturingSeat(role: Seat["role"], occupant: Occupant): { seat: Seat; submitted: () => SubmittableTransaction | undefined } {
  let last: SubmittableTransaction | undefined;
  const seat = {
    role,
    index: 0,
    occupant,
    address: `r${role}`,
    signer: {
      submit: async (tx: SubmittableTransaction) => {
        last = tx;
        return { engineResult: "tesSUCCESS", hash: "HASH" };
      },
    },
  } as unknown as Seat;
  return { seat, submitted: () => last };
}

function ownerSession(): { session: Session; submitted: () => SubmittableTransaction | undefined } {
  const map = new Map<string, Seat>();
  const { seat, submitted } = capturingSeat("owner", { kind: "human", id: "owner-1" });
  map.set("owner:0", seat);
  const session = {
    seed: "test-seed",
    seats: map,
    // delete-loan is not phase-gated, so dispatchAction must not read the vault at all for it. If it
    // does, this throws and the test fails loudly — proving the action stays off the phase-gated path.
    client: {
      request: async (req: { command: string }) => {
        throw new Error(`unexpected client call: ${req.command}`);
      },
    },
    env: {
      asset: { currency: "XRP" },
      objects: { vaultId: "V", brokerId: "B" },
      accounts: { owner: { address: "rowner" } },
    },
  } as unknown as Session;
  return { session, submitted };
}

describe("delete-loan action", () => {
  it("builds a LoanDelete signed by the acting seat over the given loanId", async () => {
    const { session, submitted } = ownerSession();
    const result = await dispatchAction(
      session,
      { seat: "owner:0", action: "delete-loan", params: { loanId: "LOAN123" } },
      "owner-1",
    );
    expect(result).toMatchObject({ action: "delete-loan", code: "tesSUCCESS", hash: "HASH" });
    expect(submitted()).toEqual({ TransactionType: "LoanDelete", Account: "rowner", LoanID: "LOAN123" });
  });

  it("is ungated — it never reads the vault phase (the mock client throws if it does)", async () => {
    const { session } = ownerSession();
    // Succeeds without the client's account_objects call ever being made; the mock would throw otherwise.
    await expect(
      dispatchAction(session, { seat: "owner:0", action: "delete-loan", params: { loanId: "LOAN123" } }, "owner-1"),
    ).resolves.toMatchObject({ code: "tesSUCCESS" });
  });

  it("400s when loanId is missing, before any submit", async () => {
    const { session } = ownerSession();
    await expect(
      dispatchAction(session, { seat: "owner:0", action: "delete-loan", params: {} }, "owner-1"),
    ).rejects.toMatchObject({ name: "ActionError", status: 400 });
    await dispatchAction(session, { seat: "owner:0", action: "delete-loan", params: {} }, "owner-1").catch((e) => {
      expect(e).toBeInstanceOf(ActionError);
      expect(e.message).toMatch(/missing parameter loanId/);
    });
  });
});
