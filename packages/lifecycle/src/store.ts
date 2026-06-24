import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LifecycleRun } from "./types.js";

// Persist a lifecycle run keyed by setup id. The record is the ordered, tx-hash-backed account of
// what the run did, suitable for a demo walkthrough or for downstream ingestion.
export function saveRun(run: LifecycleRun, dir = "out"): string {
  const target = join(resolve(dir), `${run.setupId}.lifecycle.json`);
  mkdirSync(resolve(dir), { recursive: true });
  writeFileSync(target, JSON.stringify(run, null, 2) + "\n", "utf8");
  return target;
}
