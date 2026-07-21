import { loadConfig, ConfigError } from "@lending/shared";
import { runSuite } from "./runner.js";
import { saveResults } from "./store.js";

const USAGE = `negatives — run the adversarial negative-test suite against Devnet

usage:
  negatives run --config <file> [--only N1,N7,N15] [--out-dir <dir>]

options:
  --config    a bootstrap config file (the suite provisions its own environments from it)
  --only      comma-separated case ids to run (default: all)
  --out-dir   directory for the results record (default: out)
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

async function run(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const configPath = flags.get("config");
  if (!configPath) throw new CliError("missing required --config");
  const config = loadConfig(configPath);
  const only = flags.get("only")?.split(",").map((s) => s.trim().toUpperCase());

  const result = await runSuite({ config, ...(only ? { only } : {}), log: (m) => console.log(m) });

  const path = saveResults(result, flags.get("out-dir"));
  console.log(
    `\n${result.passed}/${result.ran} cases passed` +
      `${result.deferred ? `, ${result.deferred} deferred` : ""}` +
      `${result.skipped ? `, ${result.skipped} skipped (not applicable to this vault mode)` : ""}`,
  );
  console.log(`wrote ${path}`);
  if (result.passed !== result.ran) process.exitCode = 1;
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
  if (err instanceof ConfigError || err instanceof CliError) console.error(`error: ${err.message}`);
  else console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
