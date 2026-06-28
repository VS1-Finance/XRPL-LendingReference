import { sleep } from "@lending/shared";
import type { Role } from "@lending/shared";
import type { Session } from "../session.js";
import { isBotDriven, type Seat } from "../seat.js";
import type { BotVariant } from "./variant.js";

export interface SchedulerOptions {
  variants: BotVariant[];
  // Seconds between rounds.
  intervalSeconds?: number;
  // Stop after this many rounds (default: run until stopped).
  maxRounds?: number;
  log?: (msg: string) => void;
}

// Drives the bot-held seats of a session. Each round it visits every seat; for a seat currently
// filled by a bot it runs the matching variant's tick, and for a seat a human holds it does nothing
// — so a human claiming a seat causes its bot to stand down on the next round, and a release lets the
// bot resume. Reads occupancy live each round, so claim and release take effect without restarting.
export class BotScheduler {
  private running = false;

  constructor(private readonly session: Session, private readonly options: SchedulerOptions) {}

  stop(): void {
    this.running = false;
  }

  async run(): Promise<void> {
    const log = this.options.log ?? (() => {});
    const interval = (this.options.intervalSeconds ?? 15) * 1000;
    const variantsByRole = indexByRole(this.options.variants);
    this.running = true;

    let round = 0;
    while (this.running) {
      round++;
      for (const seat of this.session.seats.values()) {
        if (!this.running) break;
        if (!isBotDriven(seat)) continue; // a human holds this seat — stand down
        const variant = variantsByRole.get(seat.role);
        if (!variant) continue;
        try {
          await variant.tick({ session: this.session, seat, log });
        } catch (err) {
          log(`bot ${keyLabel(seat)} error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (this.options.maxRounds && round >= this.options.maxRounds) break;
      if (this.running) await sleep(interval);
    }
  }
}

function indexByRole(variants: BotVariant[]): Map<Role, BotVariant> {
  const map = new Map<Role, BotVariant>();
  for (const v of variants) map.set(v.role, v);
  return map;
}

function keyLabel(seat: Seat): string {
  return `${seat.role}:${seat.index}`;
}
