import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { watchedFromProvisioned } from "./environment.js";
import { runSubscriber } from "./subscriber.js";

// Follow every session the engine provisions, not just one. The engine writes a provisioned
// environment file per session into a shared directory (its `out/`); this scans that directory,
// starts a subscriber for each session it has not already picked up, and re-scans on an interval so
// new sessions are captured as they appear. One long-running process therefore captures the whole
// deployment's history without being told about each session individually.

export interface FollowAllOptions {
  dir: string;
  // How often to re-scan the directory for new session files, in milliseconds.
  intervalMs?: number;
  log?: (msg: string) => void;
}

export async function followAll(db: PrismaClient, options: FollowAllOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const interval = options.intervalMs ?? 10_000;
  // Setup ids already being followed, so a re-scan does not start a second subscriber for one.
  const following = new Set<string>();

  const scan = (): void => {
    let files: string[];
    try {
      files = readdirSync(options.dir).filter((f) => f.endsWith(".json") && !f.endsWith(".seats.json"));
    } catch {
      return; // directory not present yet — try again next interval
    }
    for (const file of files) {
      let env;
      try {
        env = watchedFromProvisioned(join(options.dir, file));
      } catch {
        continue; // not a valid provisioned file (partial write, wrong shape) — skip for now
      }
      if (following.has(env.setupId)) continue;
      following.add(env.setupId);
      log(`following ${env.setupId} (${env.accounts.length} accounts on ${env.network})`);
      // Each session runs its own subscriber; a failure drops just that session and lets it be retried
      // on the next scan rather than tearing down the whole follower.
      void runSubscriber(db, env, { log }).catch((err) => {
        log(`subscriber for ${env.setupId} ended: ${err instanceof Error ? err.message : String(err)}`);
        following.delete(env.setupId);
      });
    }
  };

  scan();
  const timer = setInterval(scan, interval);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  clearInterval(timer);
}
