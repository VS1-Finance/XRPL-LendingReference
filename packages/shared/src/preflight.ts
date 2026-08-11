// CI preflight for the negative-suite job: fail early with a clear message if the internal treasury
// cannot cover a run, instead of a confusing mid-provision failure. Runs via `tsx` inside the shared
// workspace package, so xrpl and the funding helpers resolve — a bare node script at the repo root
// cannot resolve xrpl. Threshold is generous; it only trips on a genuinely drained wallet.
import { connect, treasuryBalanceXrp } from "./index.js";

const MIN_XRP = 500;

async function main(): Promise<void> {
  const seed = process.env.XRP_TREASURY_SEED?.trim();
  if (!seed) {
    console.log("XRP_TREASURY_SEED not set — skipping preflight (the job guard should have skipped this).");
    return;
  }
  const network = (process.env.ENGINE_NETWORK ?? "devnet") as Parameters<typeof connect>[0];
  const client = await connect(network);
  try {
    const xrp = await treasuryBalanceXrp(client, seed);
    console.log(`treasury holds ${xrp.toFixed(2)} XRP`);
    if (xrp < MIN_XRP) {
      console.error(`treasury below ${MIN_XRP} XRP — top up XRP_TREASURY_SEED before running the negative suite`);
      process.exitCode = 1;
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
