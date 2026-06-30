import type { BotContext, BotVariant, StepOutcome } from "./variant.js";
import { idle } from "./variant.js";
import { iouAmount, shareBalance } from "./reads.js";

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
      const r = await ctx.seat.signer.submit({
        TransactionType: "VaultDeposit",
        Account: ctx.seat.address,
        VaultID: ctx.session.env.objects.vaultId!,
        Amount: iouAmount(ctx.session, value),
      });
      ctx.log(`depositor ${ctx.seat.index} cycle-deposit ${value} — ${r.engineResult}`);
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
