import { db, disconnectDb } from "./db.js";
import { watchedFromProvisioned } from "./environment.js";
import { runSubscriber } from "./subscriber.js";
import { followAll } from "./follow-all.js";
import { actionsForSetup, stateForSetup, transactionCount } from "./query.js";

const USAGE = `ingester — capture and query a lending environment's history

usage:
  ingester start  --provisioned <file> [--from-ledger <n>] [--once]
  ingester follow --dir <dir> [--interval <seconds>]
  ingester query  --setup-id <id> [--correlation-id <id>] [--state]

options:
  --provisioned <file>   provisioned environment graph (which accounts to watch)
  --dir <dir>            directory of provisioned session files to follow (the engine's out/)
  --interval <seconds>   how often to re-scan the directory for new sessions (default 10)
  --from-ledger <n>      backfill from this ledger index instead of the stored cursor
  --once                 backfill and exit instead of holding the live stream open
  --setup-id <id>        the run to query
  --correlation-id <id>  narrow the action list to one correlation id
  --state                report current derived state instead of the action list
`;

class CliError extends Error {}

function parseFlags(argv: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(key, true);
    else { flags.set(key, next); i++; }
  }
  return flags;
}

function requireString(flags: Map<string, string | boolean>, key: string): string {
  const v = flags.get(key);
  if (typeof v !== "string" || !v) throw new CliError(`missing required --${key}`);
  return v;
}

async function start(flags: Map<string, string | boolean>): Promise<void> {
  const env = watchedFromProvisioned(requireString(flags, "provisioned"));
  const options: Parameters<typeof runSubscriber>[2] = { log: (m) => console.log(m) };
  if (typeof flags.get("from-ledger") === "string") options.fromLedger = Number(flags.get("from-ledger"));
  if (flags.get("once") === true) options.once = true;

  await runSubscriber(db(), env, options);
  console.log(`captured ${await transactionCount(db(), env.setupId)} transactions for ${env.setupId}`);
}

async function follow(flags: Map<string, string | boolean>): Promise<void> {
  const dir = requireString(flags, "dir");
  const intervalMs =
    typeof flags.get("interval") === "string" ? Number(flags.get("interval")) * 1000 : undefined;
  console.log(`following all sessions under ${dir}`);
  await followAll(db(), { dir, ...(intervalMs ? { intervalMs } : {}), log: (m) => console.log(m) });
}

async function query(flags: Map<string, string | boolean>): Promise<void> {
  const setupId = requireString(flags, "setup-id");
  if (flags.get("state") === true) {
    console.log(JSON.stringify(await stateForSetup(db(), setupId), null, 2));
    return;
  }
  const correlationId = typeof flags.get("correlation-id") === "string" ? (flags.get("correlation-id") as string) : undefined;
  const actions = await actionsForSetup(db(), setupId, correlationId);
  for (const a of actions) {
    console.log(`${String(a.seq).padStart(3)}  ${a.type.padEnd(20)} ${a.correlationId ?? "-"}  ${a.txHash.slice(0, 16)}…  (ledger ${a.ledgerIndex})`);
  }
  console.log(`\n${actions.length} actions`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return;
  }
  const [command, rest] = [argv[0], argv.slice(1)];
  try {
    if (command === "start") await start(parseFlags(rest));
    else if (command === "follow") await follow(parseFlags(rest));
    else if (command === "query") await query(parseFlags(rest));
    else throw new CliError(`unknown command: ${command}`);
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
