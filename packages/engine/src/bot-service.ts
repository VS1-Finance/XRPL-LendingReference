import { BotScheduler, assignWeighted, type BotWeights } from "@lending/session";
import type { Session } from "@lending/session";

// Owns the running bot schedulers, one per session. A scheduler drives the bot-held seats of its
// session continuously; a seat a human claims is skipped on the next round, so bots and humans
// coexist. The service starts and stops schedulers on request and shuts them all down when the
// engine closes.
export class BotService {
  private readonly running = new Map<string, BotScheduler>();

  constructor(private readonly weights: BotWeights) {}

  isRunning(setupId: string): boolean {
    return this.running.has(setupId);
  }

  // Start driving a session's bots. A weighted, reproducible variant assignment is drawn from the
  // configured weights and seed. Starting an already-running session is a no-op.
  start(session: Session, intervalSeconds: number): void {
    if (this.running.has(session.setupId)) return;
    const scheduler = new BotScheduler(session, {
      variants: [],
      assignment: assignWeighted(session, this.weights),
      intervalSeconds,
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
