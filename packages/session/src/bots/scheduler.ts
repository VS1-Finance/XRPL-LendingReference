import { sleep } from "@lending/shared";
import type { Session } from "../session.js";
import { isBotDriven, keyOf } from "../seat.js";
import type { BotVariant } from "./variant.js";
import { assignAutomatically, type VariantAssignment } from "./assignment.js";

export interface SchedulerOptions {
  // The variants a bot pool may run. Spread across seats automatically unless an explicit
  // per-seat assignment is given.
  variants: BotVariant[];
  // An explicit seat -> variant map, overriding automatic assignment.
  assignment?: VariantAssignment;
  // Seconds between rounds.
  intervalSeconds?: number;
  // Stop after this many rounds (default: run until stopped).
  maxRounds?: number;
  log?: (msg: string) => void;
  // Called when a bot seat acts in a round, so the action can be recorded. Only fired when the
  // variant actually submitted a transaction (StepOutcome.acted).
  onOutcome?: (seatKey: string, role: string, action: string, result: string, hash?: string) => void;
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
    const assignment = this.options.assignment ?? assignAutomatically(this.session, this.options.variants);
    this.running = true;

    let round = 0;
    while (this.running) {
      round++;
      for (const seat of this.session.seats.values()) {
        if (!this.running) break;
        if (!isBotDriven(seat)) continue; // a human holds this seat — stand down
        const variant = assignment.get(keyOf(seat));
        if (!variant) continue;
        try {
          const outcome = await variant.tick({ session: this.session, seat, log });
          if (outcome.acted) {
            this.options.onOutcome?.(keyOf(seat), seat.role, outcome.action, outcome.result, outcome.hash);
          }
        } catch (err) {
          log(`bot ${keyOf(seat)} error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (this.options.maxRounds && round >= this.options.maxRounds) break;
      if (this.running) await sleep(interval);
    }
  }
}
