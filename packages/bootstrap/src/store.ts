import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ProvisionedEnvironment } from "./types.js";

// Provisioned environments are written to disk keyed by setup id, so a re-run can load the prior
// graph and a teardown can find what to remove. The store survives a ledger reset, which a re-run
// relies on to know which accounts and objects were provisioned.
const DEFAULT_DIR = "out";

function pathFor(setupId: string, dir: string): string {
  return join(resolve(dir), `${setupId}.json`);
}

export function saveEnvironment(env: ProvisionedEnvironment, dir = DEFAULT_DIR): string {
  const target = pathFor(env.setupId, dir);
  mkdirSync(resolve(dir), { recursive: true });
  writeFileSync(target, JSON.stringify(env, null, 2) + "\n", "utf8");
  return target;
}

export function loadEnvironment(setupId: string, dir = DEFAULT_DIR): ProvisionedEnvironment | undefined {
  const target = pathFor(setupId, dir);
  if (!existsSync(target)) return undefined;
  return JSON.parse(readFileSync(target, "utf8")) as ProvisionedEnvironment;
}

export function deleteEnvironment(setupId: string, dir = DEFAULT_DIR): boolean {
  const target = pathFor(setupId, dir);
  if (!existsSync(target)) return false;
  rmSync(target);
  return true;
}
