import { waitForLedgerAdvance } from "@lending/shared";
import type { Session } from "../session.js";
import { fillWithBot, isBotDriven, isOpen, keyOf } from "../seat.js";
import type { Seat } from "../seat.js";
import type { BotVariant } from "./variant.js";
import { assignAutomatically, type VariantAssignment } from "./assignment.js";

// Order seats by role then numeric index — identical to buildSeats' insertion order at any pool size,
// but pinned explicitly so a future change to how seats are populated can't silently reorder actions.
// A plain string-key sort (e.g. "depositor:10" vs "depositor:2") would diverge from insertion order
// lexicographically once a role has 10+ seats, so the index must compare numerically, not as text.
const bySeat = (a: Seat, b: Seat): number =>
  a.role === b.role ? a.index - b.index : a.role.localeCompare(b.role);

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

  // A seat that submits the same rejection this many times in a row has hit a wall it cannot clear
  // (e.g. a depositor against a full vault) and stands down for the rest of the run, so it does not
  // burn rounds — and the ledger — retrying a transaction that will keep failing.
  private static readonly GIVE_UP_AFTER = 3;

  async run(): Promise<void> {
    const log = this.options.log ?? (() => {});
    const interval = (this.options.intervalSeconds ?? 15) * 1000;
    const assignment = this.options.assignment ?? assignAutomatically(this.session, this.options.variants);
    this.running = true;

    // Per-seat record of the last rejection and how many times it has repeated consecutively. A seat
    // that reaches the give-up threshold is added to `exhausted` and skipped thereafter.
    const lastReject = new Map<string, { code: string; count: number }>();
    const exhausted = new Set<string>();

    let round = 0;
    while (this.running) {
      round++;
      // Self-heal: a seat a human released mid-run is now "open". If it has a variant assigned,
      // promote it back to bot control so the pool resumes driving it this same round. Clear any
      // stand-down bookkeeping for that seat so a returned seat starts with a clean slate.
      // Iterate a stably-sorted snapshot (role, then numeric index) rather than raw Map order. Map
      // insertion order is already deterministic today, so this is behaviorally a no-op — but it pins
      // the guarantee explicitly so a future change to how seats are populated cannot silently reorder
      // bot actions.
      const orderedSeatsHeal = [...this.session.seats.values()].sort(bySeat);
      for (const seat of orderedSeatsHeal) {
        const key = keyOf(seat);
        if (isOpen(seat) && assignment.get(key)) {
          fillWithBot(seat);
          lastReject.delete(key);
          exhausted.delete(key);
        }
      }
      const orderedSeats = [...this.session.seats.values()].sort(bySeat);
      for (const seat of orderedSeats) {
        if (!this.running) break;
        if (!isBotDriven(seat)) continue; // a human holds this seat — stand down
        const key = keyOf(seat);
        if (exhausted.has(key)) continue; // this seat has given up on a repeatedly-failing action
        const variant = assignment.get(key);
        if (!variant) continue;
        try {
          const outcome = await variant.tick({ session: this.session, seat, log });
          if (outcome.acted) {
            this.options.onOutcome?.(key, seat.role, outcome.action, outcome.result, outcome.hash);
            // Track consecutive identical rejections; a success clears the streak.
            if (outcome.result === "tesSUCCESS") {
              lastReject.delete(key);
            } else {
              const prev = lastReject.get(key);
              const count = prev && prev.code === outcome.result ? prev.count + 1 : 1;
              lastReject.set(key, { code: outcome.result, count });
              if (count >= BotScheduler.GIVE_UP_AFTER) {
                exhausted.add(key);
                log(`bot ${key} standing down — ${outcome.result} ${count}× in a row`);
              }
            }
          }
        } catch (err) {
          log(`bot ${key} error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Stop once the round budget is reached, or once every bot-driven seat has given up.
      if (this.options.maxRounds && round >= this.options.maxRounds) break;
      if (this.allExhausted(assignment, exhausted)) {
        log(`all bot seats have stood down — stopping after round ${round}`);
        break;
      }
      // Pace on ledger progression, not the host wall clock, so two runs with the same seed observe
      // ledger state at the same logical points — the basis of deterministic bot behavior. Advance at
      // least one validated ledger between rounds; intervalSeconds bounds the wait so a stalled network
      // cannot wedge the pool.
      if (this.running) await waitForLedgerAdvance(this.session.client, { minLedgers: 1, timeoutMs: interval });
    }
  }

  // True when there is no more work for the scheduler to do: every assigned seat has either stood down
  // or is human-held. A seat a human released to "open" still counts as active — the next round's
  // self-heal re-fills it — so the pool must not stop while such a reclaimable seat exists (otherwise a
  // released owner seat could stall the market instead of returning to bot control).
  private allExhausted(assignment: VariantAssignment, exhausted: Set<string>): boolean {
    let active = 0;
    for (const seat of this.session.seats.values()) {
      const key = keyOf(seat);
      if (!assignment.get(key)) continue;
      if (!isBotDriven(seat) && !isOpen(seat)) continue; // human-held seats are not the pool's work
      if (!exhausted.has(key)) active++;
    }
    return active === 0;
  }
}
