import { describe, it, expect } from "vitest";
import { dispatchAction, ActionError } from "./action-service.js";
import type { Session } from "@lending/session";
import type { Seat, Occupant } from "@lending/session";

// An MPT amount with more fractional digits than the vault asset's scale (2) makes
// decimalToScaled throw "has more than 2 fractional digits" while assetAmount builds the
// VaultDeposit transaction, before any ledger call. asClientError must classify that as a clean
// 400, not let it fall through to an opaque 500 — this is the precision-overflow fix.

function seat(role: Seat["role"], index: number, occupant: Occupant): Seat {
  return { role, index, occupant, address: `r${role}${index}`, signer: { submit: async () => ({ engineResult: "tesSUCCESS" }) } } as unknown as Seat;
}

function mptSession(): Session {
  const map = new Map<string, Seat>();
  const depositor = seat("depositor", 0, { kind: "human", id: "alice" });
  map.set("depositor:0", depositor);
  return {
    seed: "test-seed",
    seats: map,
    // dispatchAction now reads the owner's vault first to phase-gate deposit/withdraw. Return no vault
    // object (a non-closed-ended vault in this test) so vaultPhase is null and the action is ungated,
    // preserving this test's intent: amount validation, not a real ledger submit, is what's exercised.
    client: {
      request: async (req: { command: string }) => {
        if (req.command === "account_objects") return { result: { account_objects: [] } };
        throw new Error(`unexpected client call: ${req.command}`);
      },
    },
    env: {
      asset: { currency: "MPT" },
      objects: { vaultId: "V", assetMptId: "00081A9C7E4C5EFD1DFD0C6E8F5F3B0A5E4E2A1B2C3D4E5F" },
      accounts: { owner: { address: "rOwner" } },
    },
  } as unknown as Session;
}

describe("MPT amount precision overflow", () => {
  it("400s (not 500s) when a deposit amount has more fractional digits than the asset scale", async () => {
    const session = mptSession();
    await expect(dispatchAction(session, { seat: "depositor:0", action: "deposit", params: { amount: "100.555" } }, "alice")).rejects.toMatchObject({
      name: "ActionError",
      status: 400,
    });
    await dispatchAction(session, { seat: "depositor:0", action: "deposit", params: { amount: "100.555" } }, "alice").catch((e) => {
      expect(e).toBeInstanceOf(ActionError);
      expect(e.message).toMatch(/has more than 2 fractional digits/);
    });
  });

  it("still succeeds for a valid MPT-scale amount (regression guard)", async () => {
    const session = mptSession();
    const result = await dispatchAction(session, { seat: "depositor:0", action: "deposit", params: { amount: "100.55" } }, "alice");
    expect(result.code).toBe("tesSUCCESS");
  });
});
