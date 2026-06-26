import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SuiteResult } from "./types.js";

// Persist a suite run: the ordered per-case record of expected vs. observed outcome, suitable for a
// CI artifact or a demo walkthrough.
export function saveResults(result: SuiteResult, dir = "out"): string {
  const target = join(resolve(dir), `${result.setupId}.negatives.json`);
  mkdirSync(resolve(dir), { recursive: true });
  writeFileSync(target, JSON.stringify(result, null, 2) + "\n", "utf8");
  return target;
}
