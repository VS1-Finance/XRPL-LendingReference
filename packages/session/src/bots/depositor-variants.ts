import { decimalToScaled } from "@lending/shared";
import type { BotContext, BotVariant, StepOutcome } from "./variant.js";
import { idle } from "./variant.js";
import { iouAmount, shareBalance, vaultDepositHeadroom } from "./reads.js";

// Vault shares are minted at the vault's scale (6), so a deposit of V asset units mints roughly
// V * 10^6 share base units. Used to gauge how much a topper has already contributed.
const SHARE_SCALE = 6;

// A depositor that churns liquidity: it deposits when it holds no shares, and withdraws its full
// position when it does — cycling in and out of the vault rather than holding. Phase is inferred
// from the current share balance, so the variant stays stateless and idempotent per tick.
export const depositWithdrawCycle = (value = "20000"): BotVariant => ({
  role: "depositor",
  name: "deposit-withdraw-cycle",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const shareMptId = ctx.session.env.objects.shareMptId!;
    const held = await shareBalance(ctx.session.client, ctx.seat.address, shareMptId);

    if (held === 0n) {
      const headroom = await vaultDepositHeadroom(ctx.session);
      if (headroom < 1) return idle;
      const amount = Math.min(Number(value), Math.floor(headroom)).toString();
      const r = await ctx.seat.signer.submit({
        TransactionType: "VaultDeposit",
        Account: ctx.seat.address,
        VaultID: ctx.session.env.objects.vaultId!,
        Amount: iouAmount(ctx.session, amount),
      });
      ctx.log(`depositor ${ctx.seat.index} cycle-deposit ${amount} — ${r.engineResult}`);
      return { acted: true, action: "VaultDeposit", result: r.engineResult, hash: r.hash };
    }

    // Holding shares — withdraw the full position by redeeming every share.
    const r = await ctx.seat.signer.submit({
      TransactionType: "VaultWithdraw",
      Account: ctx.seat.address,
      VaultID: ctx.session.env.objects.vaultId!,
      Amount: { mpt_issuance_id: shareMptId, value: held.toString() },
    });
    ctx.log(`depositor ${ctx.seat.index} cycle-withdraw ${held} shares — ${r.engineResult}`);
    return { acted: true, action: "VaultWithdraw", result: r.engineResult, hash: r.hash };
  },
});

// A depositor that tops up its position in increments: it adds a fixed amount each tick until its
// contributed total reaches a target, then holds. Models a depositor building a position over time
// rather than in one deposit.
export const topUp = (increment = "5000", targetTotal = "20000"): BotVariant => ({
  role: "depositor",
  name: "top-up",
  async tick(ctx: BotContext): Promise<StepOutcome> {
    const shareMptId = ctx.session.env.objects.shareMptId!;
    const held = await shareBalance(ctx.session.client, ctx.seat.address, shareMptId);
    const targetShares = decimalToScaled(targetTotal, SHARE_SCALE);
    if (held >= targetShares) return idle;

    const headroom = await vaultDepositHeadroom(ctx.session);
    if (headroom < 1) return idle;
    const amount = Math.min(Number(increment), Math.floor(headroom)).toString();

    const r = await ctx.seat.signer.submit({
      TransactionType: "VaultDeposit",
      Account: ctx.seat.address,
      VaultID: ctx.session.env.objects.vaultId!,
      Amount: iouAmount(ctx.session, amount),
    });
    ctx.log(`depositor ${ctx.seat.index} top-up ${amount} — ${r.engineResult}`);
    return { acted: true, action: "VaultDeposit", result: r.engineResult, hash: r.hash };
  },
});
