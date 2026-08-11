import { BotScheduler, assignWeighted, scenarioWeights, fillWithBot, type BotWeights } from "@lending/session";
import type { Session } from "@lending/session";
import type { SessionService } from "./session-service.js";

// The ledger transaction types bots submit, mapped to the engine's action vocabulary so a bot action
// reads the same as the equivalent human action in the log.
const BOT_ACTION: Record<string, string> = {
  VaultDeposit: "deposit",
  VaultWithdraw: "withdraw",
  LoanSet: "originate",
  LoanPay: "repay",
  LoanManage: "manage-loan",
};

// Owns the running bot schedulers, one per session. A scheduler drives the bot-held seats of its
// session continuously; a seat a human claims is skipped on the next round, so bots and humans
// coexist. Each bot action is recorded in the session's log. The service starts and stops schedulers
// on request and shuts them all down when the engine closes.
export class BotService {
  private readonly running = new Map<string, BotScheduler>();

  constructor(
    private readonly weights: BotWeights,
    private readonly sessions: SessionService,
  ) {}

  isRunning(setupId: string): boolean {
    return this.running.has(setupId);
  }

  // Start driving a session's bots. A weighted, reproducible variant assignment is drawn from the
  // session's scenario (or the base weights if none was chosen). Starting an already-running session
  // is a no-op.
  start(session: Session, intervalSeconds: number): void {
    if (this.running.has(session.setupId)) return;
    // Fill every unheld seat with a bot so "start bots" runs the whole market, not only the seats a
    // bot already occupies. Seats a human holds are left untouched; a seat released later goes open
    // again, and a subsequent start re-fills it.
    for (const seat of session.seats.values()) fillWithBot(seat);
    // A session's scenario preset selects the variant weights; without one, the base weights apply.
    // A session's scenario preset selects the variant weights; without one, the base weights apply. The
    // per-session bot seed (supplied at setup or generated) seeds the assignment; fall back to the base
    // seed only if none was recorded, so the assignment is reproducible per session. Keep the base
    // weight numbers on the no-scenario branch — only the seed changes.
    const scenario = this.sessions.scenarioFor(session.setupId);
    const seed = this.sessions.botSeedFor(session.setupId) ?? this.weights.seed;
    const weights = scenario ? scenarioWeights(scenario, seed) : { ...this.weights, seed };
    const scheduler = new BotScheduler(session, {
      variants: [],
      assignment: assignWeighted(session, weights),
      intervalSeconds,
      // Run a bounded number of rounds — enough for the pool to complete one or two full lifecycles
      // (deposit, originate, repay or default, withdraw) — then stop, rather than driving the market
      // forever. Starting the pool again resumes it. Overridable via BOT_MAX_ROUNDS.
      maxRounds: Number(process.env.BOT_MAX_ROUNDS ?? 20),
      onOutcome: (seatKey, role, action, result, hash) => {
        void this.sessions.recordAction(session.setupId, {
          actor: seatKey,
          role,
          by: "bot",
          action: BOT_ACTION[action] ?? action,
          code: result,
          hash,
        });
      },
    });
    this.running.set(session.setupId, scheduler);
    // Run in the background; the scheduler loops until stopped.
    void scheduler.run().finally(() => this.running.delete(session.setupId));
  }

  stop(setupId: string): void {
    this.running.get(setupId)?.stop();
    this.running.delete(setupId);
  }

  stopAll(): void {
    for (const scheduler of this.running.values()) scheduler.stop();
    this.running.clear();
  }
}
