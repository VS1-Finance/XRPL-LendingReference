import { readdirSync } from "node:fs";
import { loadConfig, ConfigError } from "@lending/shared";
import { loadEnvironment, saveEnvironment } from "@lending/bootstrap";
import { createSession, attachSession, closeSession } from "./session.js";
import { claim, release } from "./seat.js";
import { applyOccupancy, saveOccupancy } from "./occupancy.js";
import { BotScheduler } from "./bots/scheduler.js";
import { isProfileName, profileVariants } from "./bots/profiles.js";

const USAGE = `session — create and drive lending sessions with any-role seats

usage:
  session create   --config <file> [--out-dir <dir>]
  session list     [--out-dir <dir>]
  session join     --setup-id <id> --seat <role:index> --as <participant> --seed <seed> [--out-dir <dir>]
  session release  --setup-id <id> --seat <role:index> --as <participant> --seed <seed> [--out-dir <dir>]
  session run-bots --setup-id <id> --seed <seed> [--profile happy|adversarial] [--rounds <n>] [--interval <s>] [--out-dir <dir>]

A session is a provisioned environment. Every role is a seat: bots fill the seats no human holds,
and a participant claims a seat to act as that role. Multiple participants may hold different seats
in the same session.
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

function need(flags: Map<string, string>, key: string): string {
  const v = flags.get(key);
  if (!v) throw new CliError(`missing required --${key}`);
  return v;
}

async function create(flags: Map<string, string>): Promise<void> {
  const config = loadConfig(need(flags, "config"));
  const dir = flags.get("out-dir");
  const session = await createSession(config);
  saveEnvironment(session.env, dir);
  saveOccupancy(session.setupId, session.seats, dir);
  await closeSession(session);

  console.log(`created session ${session.setupId} on ${session.network}`);
  for (const [key, seat] of session.seats) console.log(`  ${key.padEnd(14)} ${seat.address}  (${seat.occupant.kind})`);
}

function list(flags: Map<string, string>): void {
  const dir = flags.get("out-dir") ?? "out";
  // Listing reads persisted environments; a session is discoverable once its graph is on disk.
  console.log(`sessions in ${dir}:`);
  const setupId = flags.get("setup-id");
  const ids = setupId ? [setupId] : discoverSetupIds(dir);
  if (!ids.length) { console.log("  (none)"); return; }
  for (const id of ids) {
    const env = loadEnvironment(id, dir);
    if (env) console.log(`  ${id}  ${env.network}  vault ${env.objects.vaultId?.slice(0, 12)}…`);
  }
}

async function joinOrRelease(flags: Map<string, string>, mode: "join" | "release"): Promise<void> {
  const setupId = need(flags, "setup-id");
  const seatKey = need(flags, "seat");
  const participant = need(flags, "as");
  const seed = need(flags, "seed");
  const dir = flags.get("out-dir");

  const env = loadEnvironment(setupId, dir);
  if (!env) throw new CliError(`no session found for ${setupId}`);
  const session = await attachSession(env, seed);
  try {
    applyOccupancy(setupId, session.seats, dir);
    const seat = session.seats.get(seatKey);
    if (!seat) throw new CliError(`session ${setupId} has no seat ${seatKey}`);
    if (mode === "join") claim(seat, participant);
    else release(seat, participant);
    saveOccupancy(setupId, session.seats, dir);
    console.log(`${participant} ${mode === "join" ? "joined" : "released"} ${seatKey} in ${setupId} (now ${seat.occupant.kind})`);
  } finally {
    await closeSession(session);
  }
}

async function runBots(flags: Map<string, string>): Promise<void> {
  const setupId = need(flags, "setup-id");
  const seed = need(flags, "seed");
  const dir = flags.get("out-dir");
  const env = loadEnvironment(setupId, dir);
  if (!env) throw new CliError(`no session found for ${setupId}`);

  const profile = flags.get("profile") ?? "happy";
  if (!isProfileName(profile)) throw new CliError(`unknown --profile ${profile} (use happy or adversarial)`);

  const session = await attachSession(env, seed);
  try {
    applyOccupancy(setupId, session.seats, dir);
    const scheduler = new BotScheduler(session, {
      variants: profileVariants(profile),
      intervalSeconds: Number(flags.get("interval") ?? 10),
      maxRounds: flags.get("rounds") ? Number(flags.get("rounds")) : 3,
      log: (m) => console.log(m),
    });
    console.log(`running bots for ${setupId} with the ${profile} profile (seats a human holds are left alone)`);
    await scheduler.run();
    console.log("bot run complete");
  } finally {
    await closeSession(session);
  }
}

function discoverSetupIds(dir: string): string[] {
  try {
    // A provisioned graph is stored as "<setup-id>.json"; the seats sidecar and lifecycle records
    // are excluded so each session is listed once.
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.includes(".seats") && !f.includes(".lifecycle") && !f.includes(".negatives"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const flags = parseFlags(argv.slice(1));
  switch (command) {
    case "create": return create(flags);
    case "list": return void list(flags);
    case "join": return joinOrRelease(flags, "join");
    case "release": return joinOrRelease(flags, "release");
    case "run-bots": return runBots(flags);
    default:
      console.log(USAGE);
      if (command && command !== "--help" && command !== "-h") process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof ConfigError || err instanceof CliError) console.error(`error: ${err.message}`);
  else console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
