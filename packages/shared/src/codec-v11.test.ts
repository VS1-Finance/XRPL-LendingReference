import { describe, it, expect } from "vitest";
import { Wallet, type Transaction } from "xrpl";
import { decode } from "ripple-binary-codec";
import { registerLendingV11Fields } from "./codec-v11.js";

// These hand-built tx objects carry the three LendingProtocolV1_1 fields (VaultKind, SubscriptionDate,
// RedemptionDate) that our pinned xrpl types predate — the entire reason this registrar exists — so
// they cannot nominally satisfy xrpl's bundled `VaultCreate` type. Sequence/Fee/SigningPubKey are also
// hand-supplied (no autofill): Wallet.sign() signs the literal object as given.

describe("registerLendingV11Fields", () => {
  it("lets Wallet.sign serialize a VaultCreate carrying the V1_1 fields, round-tripping intact", () => {
    registerLendingV11Fields();
    const w = Wallet.generate();
    const tx = {
      TransactionType: "VaultCreate" as const,
      Account: w.address,
      Asset: { currency: "XRP" },
      WithdrawalPolicy: 1,
      VaultKind: 1,
      SubscriptionDate: 800000000,
      RedemptionDate: 800001000,
      Sequence: 1, Fee: "10", Flags: 0, SigningPubKey: "", LastLedgerSequence: 100,
    };
    const signed = w.sign(tx as unknown as Transaction);
    const decoded = decode(signed.tx_blob) as Record<string, unknown>;
    expect(decoded.VaultKind).toBe(1);
    expect(decoded.SubscriptionDate).toBe(800000000);
    expect(decoded.RedemptionDate).toBe(800001000);
  });

  it("is idempotent — calling twice does not throw or corrupt the field", () => {
    registerLendingV11Fields();
    registerLendingV11Fields();
    const w = Wallet.generate();
    const tx = {
      TransactionType: "VaultCreate" as const, Account: w.address, Asset: { currency: "XRP" },
      WithdrawalPolicy: 1, VaultKind: 1, SubscriptionDate: 800000000, RedemptionDate: 800001000,
      Sequence: 1, Fee: "10", Flags: 0, SigningPubKey: "", LastLedgerSequence: 100,
    };
    const signed = w.sign(tx as unknown as Transaction);
    expect(typeof signed.tx_blob).toBe("string");
  });
});
