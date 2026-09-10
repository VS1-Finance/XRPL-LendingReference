import { describe, it, expect } from "vitest";
import { Wallet } from "xrpl";
import { decode } from "ripple-binary-codec";
import { verify } from "ripple-keypairs";
import { registerLendingV11Fields } from "./codec-v11.js";
import { signLoanSetByCounterpartyCPT, COUNTERPARTY_TX_SIGN_PREFIX, counterpartySigningDataHex } from "./loanset-counterparty.js";

describe("signLoanSetByCounterpartyCPT", () => {
  it("attaches a counterparty signature that verifies under the CPT prefix (0x43505400)", () => {
    registerLendingV11Fields();
    const owner = Wallet.generate();
    const counterparty = Wallet.generate();
    const tx = {
      TransactionType: "LoanSet" as const,
      Account: owner.address,
      LoanBrokerID: "0".repeat(64),
      Counterparty: counterparty.address,
      PrincipalRequested: "1000000",
      InterestRate: 50000,
      PaymentInterval: 60,
      GracePeriod: 60,
      LoanOriginationFee: "0",
      Sequence: 1, Fee: "10", Flags: 0, SigningPubKey: owner.publicKey, LastLedgerSequence: 100,
    };
    const ownerSigned = owner.sign(tx);
    const { tx_blob } = signLoanSetByCounterpartyCPT(counterparty, ownerSigned.tx_blob);
    const decoded = decode(tx_blob) as Record<string, any>;
    expect(decoded.CounterpartySignature?.SigningPubKey).toBe(counterparty.publicKey);

    // Verify the signature over the CPT signing data — reusing the helper's own exported signing-data
    // function. This is the real assertion that the prefix is CPT, not the default TxSign: a signature
    // computed over the wrong prefix would fail verify() here.
    const hex = counterpartySigningDataHex(decoded);
    expect(verify(hex, decoded.CounterpartySignature.TxnSignature, counterparty.publicKey)).toBe(true);
  });

  it("exports the CPT prefix as the exact 4 bytes 0x43 0x50 0x54 0x00", () => {
    expect(Array.from(COUNTERPARTY_TX_SIGN_PREFIX)).toEqual([0x43, 0x50, 0x54, 0x00]);
  });
});
