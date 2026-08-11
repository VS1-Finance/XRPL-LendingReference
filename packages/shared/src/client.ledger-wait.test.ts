import { describe, it, expect } from "vitest";
import { waitForLedgerAdvance } from "./client.js";
import type { Client } from "xrpl";

// A fake client whose ledger_current index advances by one on each successive request, so the wait
// resolves deterministically without a real connection.
function fakeClient(startIndex: number): Client {
  let idx = startIndex;
  return {
    request: async (req: { command: string }) => {
      if (req.command === "ledger_current") return { result: { ledger_current_index: idx++ } };
      throw new Error(`unexpected: ${req.command}`);
    },
  } as unknown as Client;
}

describe("waitForLedgerAdvance", () => {
  it("resolves once the ledger index has advanced by minLedgers", async () => {
    const client = fakeClient(100);
    const result = await waitForLedgerAdvance(client, { minLedgers: 1, pollMs: 1, timeoutMs: 2000 });
    expect(result).toBeGreaterThanOrEqual(101);
  });

  it("resolves (does not throw) on timeout when the ledger never advances", async () => {
    // A client stuck at one index — the wait must time out and resolve, not hang or throw.
    const stuck = { request: async () => ({ result: { ledger_current_index: 100 } }) } as unknown as Client;
    const result = await waitForLedgerAdvance(stuck, { minLedgers: 5, pollMs: 1, timeoutMs: 30 });
    expect(result).toBe(100);
  });
});
