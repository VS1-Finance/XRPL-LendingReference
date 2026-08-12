import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "../session.js";
import type { Seat } from "../seat.js";
import type { SubmitResult } from "../signer.js";

// The overpay borrower variant pays the full outstanding plus a fixed overpayment — but must cap that
// total at what the borrower can actually afford. On a real XRP loan a payment above the account's
// spendable balance is rejected (tecUNFUNDED, or tecNO_PERMISSION once the loan impairs while the bot
// retries the impossible amount), which wedges the loan forever. This is exactly what stranded a live
// deployed session: outstanding 400, extra 1000 → a 1400 XRP LoanPay from a borrower holding 903 XRP,
// rejected on every retry. These tests pin the cap so an overpay never exceeds repayHeadroom, and never
// falls below the outstanding (the loan still settles in full even when the extra is unaffordable).

// Mock the ledger-reading layer so the variant's arithmetic can be exercised without a live ledger.
vi.mock("./reads.js", () => ({
  payableLoan: vi.fn(),
  outstandingToPay: vi.fn(),
  repayHeadroom: vi.fn(),
  loanDefaulted: vi.fn().mockResolvedValue(false),
  // assetAmount just echoes the whole-token value through for the assertion (we assert the whole-token
  // amount the variant computed, before any XRP/MPT shaping).
  assetAmount: vi.fn((_session: Session, value: string) => value),
}));

import { overpay } from "./borrower-variants.js";
import { payableLoan, outstandingToPay, repayHeadroom } from "./reads.js";

// A fake context whose signer records the tx it was asked to submit, so the test can read back the
// LoanPay Amount the variant chose.
function makeCtx(): { ctx: { session: Session; seat: Seat; log: () => void }; submitted: () => Record<string, unknown> | undefined } {
  let lastTx: Record<string, unknown> | undefined;
  const signer = {
    address: "rBorrower0",
    async submit(tx: Record<string, unknown>): Promise<SubmitResult> {
      lastTx = tx;
      return { hash: "HASH", engineResult: "tesSUCCESS" };
    },
  };
  const seat = { role: "borrower", index: 0, address: "rBorrower0", signer, occupant: { kind: "bot" } } as unknown as Seat;
  const session = { client: {} } as unknown as Session;
  return { ctx: { session, seat, log: () => {} }, submitted: () => lastTx };
}

// Point payableLoan at a live loan with the given outstanding, and pin the two reads the cap depends on.
function arrange(outstanding: number, headroom: number): void {
  vi.mocked(payableLoan).mockResolvedValue({ index: "LOAN1", TotalValueOutstanding: String(outstanding) } as Record<string, unknown>);
  vi.mocked(outstandingToPay).mockReturnValue(String(outstanding));
  vi.mocked(repayHeadroom).mockResolvedValue(headroom);
}

describe("overpay variant affordability cap", () => {
  beforeEach(() => vi.clearAllMocks());

  it("caps the payment at repayHeadroom when outstanding+extra exceeds it (the live-wedge case)", async () => {
    // The exact failure: outstanding 400, default extra 1000, borrower can afford 900. Uncapped this
    // submitted 1400 and looped on tecNO_PERMISSION; capped it must submit 900.
    arrange(400, 900);
    const { ctx, submitted } = makeCtx();
    await overpay().tick(ctx);
    expect(Number(submitted()?.Amount)).toBe(900);
  });

  it("pays outstanding+extra in full when the borrower can afford it", async () => {
    arrange(400, 5000);
    const { ctx, submitted } = makeCtx();
    await overpay().tick(ctx);
    expect(Number(submitted()?.Amount)).toBe(1400); // 400 + 1000, well within 5000 headroom
  });

  it("never drops below the outstanding, even when the extra is entirely unaffordable", async () => {
    // Borrower can afford exactly the outstanding and not a drop more — still repay in full (400), not
    // an underpayment that would fail differently.
    arrange(400, 400);
    const { ctx, submitted } = makeCtx();
    await overpay().tick(ctx);
    expect(Number(submitted()?.Amount)).toBe(400);
  });

  it("submits the full outstanding+extra when headroom is unbounded (IOU/MPT borrowers)", async () => {
    arrange(400, Infinity);
    const { ctx, submitted } = makeCtx();
    await overpay().tick(ctx);
    expect(Number(submitted()?.Amount)).toBe(1400);
  });

  it("honors a custom extra, still capped by affordability", async () => {
    arrange(400, 500); // 400 + 250 = 650 wanted, but only 500 affordable → 500
    const { ctx, submitted } = makeCtx();
    await overpay("250").tick(ctx);
    expect(Number(submitted()?.Amount)).toBe(500);
  });

  it("idles when there is no payable loan", async () => {
    vi.mocked(payableLoan).mockResolvedValue(undefined);
    const { ctx, submitted } = makeCtx();
    const out = await overpay().tick(ctx);
    expect(out).toEqual({ acted: false });
    expect(submitted()).toBeUndefined();
  });
});
