import { EnvironmentError, loadProvisioned } from "./environment.js";
import { runLifecycle } from "./runner.js";
import { saveRun } from "./store.js";

const USAGE = `lifecycle — run one loan lifecycle against a provisioned environment

usage:
  lifecycle run --provisioned <file> --seed <seed> [options]

options:
  --provisioned <file>   provisioned environment graph emitted by the bootstrap harness
  --seed <seed>          derivation seed for the environment's accounts
  --deposit <amount>     liquidity the depositor supplies      (default: 30000)
  --principal <amount>   loan principal                        (default: 10000)
  --interest <rate>      interest rate, scaled integer         (default: 50000)
  --interval <seconds>   payment interval, at least 60         (default: 60)
  --out-dir <dir>        directory for the run record          (default: out)
`;

class CliError extends Error {}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new CliError(`flag --${arg.slice(2)} needs a value`);
    flags.set(arg.slice(2), next);
    i++;
  }
  return flags;
}

function required(flags: Map<string, string>, key: string): string {
  const v = flags.get(key);
  if (!v) throw new CliError(`missing required --${key}`);
  return v;
}

async function run(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const env = loadProvisioned(required(flags, "provisioned"));
  const seed = required(flags, "seed");

  const interval = Number(flags.get("interval") ?? 60);
  if (!Number.isFinite(interval) || interval < 60) throw new CliError("--interval must be at least 60 seconds");

  const result = await runLifecycle(env, {
    seed,
    depositAmount: flags.get("deposit") ?? "30000",
    terms: {
      principal: flags.get("principal") ?? "10000",
      interestRate: Number(flags.get("interest") ?? 50000),
      paymentInterval: interval,
      gracePeriod: interval,
    },
    intervalSeconds: interval,
    log: (m) => console.log(m),
  });

  const path = saveRun(result, flags.get("out-dir"));
  console.log(`\n${result.reachedRepaid ? "repaid" : "incomplete"}, ${result.closed ? "closed" : "open"} — ${result.steps.length} steps`);
  console.log(`wrote ${path}`);
  if (!result.reachedRepaid || !result.closed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return;
  }
  const rest = argv[0] === "run" ? argv.slice(1) : argv;
  await run(rest);
}

main().catch((err) => {
  if (err instanceof EnvironmentError || err instanceof CliError) {
    console.error(`error: ${err.message}`);
  } else {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  process.exitCode = 1;
});
