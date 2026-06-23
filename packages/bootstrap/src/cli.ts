import { loadConfig, ConfigError } from "@lending/shared";
import { provision } from "./provision.js";
import { teardown } from "./teardown.js";

const USAGE = `bootstrap — stand up or tear down a wired lending environment

usage:
  bootstrap --config <path> [--setup-id <id>] [--out-dir <dir>] [--dry-run]
  bootstrap teardown --setup-id <id> [--seed <seed>] [--out-dir <dir>]

options:
  --config    path to a JSON config file
  --setup-id  identifies the environment; generated on provision if omitted
  --seed      derivation seed for teardown (defaults to the config seed if provisioning)
  --out-dir   directory for the provisioned graph (default: out)
  --dry-run   validate config and derive accounts without touching the network
`;

function parseFlags(argv: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i++;
    }
  }
  return flags;
}

function requireString(flags: Map<string, string | boolean>, key: string): string {
  const value = flags.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`missing required --${key}`);
  }
  return value;
}

class CliError extends Error {}

async function runProvision(flags: Map<string, string | boolean>): Promise<void> {
  const config = loadConfig(requireString(flags, "config"));
  if (typeof flags.get("setup-id") === "string") config.setupId = flags.get("setup-id") as string;
  const outDir = typeof flags.get("out-dir") === "string" ? (flags.get("out-dir") as string) : undefined;

  if (flags.get("dry-run") === true) {
    console.log(`config valid for ${config.network}; setup id ${config.setupId ?? "(generated at run time)"}`);
    return;
  }

  const env = await provision(config, { ...(outDir ? { outDir } : {}), log: (m) => console.log(m) });
  console.log(`\nprovisioned ${env.setupId}`);
  console.log(`  domain ${env.objects.domainId ?? "-"}`);
  console.log(`  vault  ${env.objects.vaultId ?? "-"}`);
  console.log(`  broker ${env.objects.brokerId ?? "-"}`);
}

async function runTeardown(flags: Map<string, string | boolean>): Promise<void> {
  const setupId = requireString(flags, "setup-id");
  const outDir = typeof flags.get("out-dir") === "string" ? (flags.get("out-dir") as string) : undefined;
  let seed = typeof flags.get("seed") === "string" ? (flags.get("seed") as string) : undefined;
  if (!seed && typeof flags.get("config") === "string") {
    seed = loadConfig(flags.get("config") as string).seed;
  }
  if (!seed) throw new CliError("teardown needs --seed (or --config to read it from)");

  await teardown(setupId, { seed, ...(outDir ? { outDir } : {}), log: (m) => console.log(m) });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return;
  }

  const [command, rest] = argv[0] === "teardown" ? ["teardown", argv.slice(1)] : ["provision", argv];
  const flags = parseFlags(rest);

  if (command === "teardown") await runTeardown(flags);
  else await runProvision(flags);
}

main().catch((err) => {
  if (err instanceof ConfigError || err instanceof CliError) {
    console.error(`error: ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
  process.exitCode = 1;
});
