import { describe, it, expect } from "vitest";
import { BotScheduler, type SchedulerOptions } from "./scheduler.js";
import type { BotVariant, StepOutcome } from "./variant.js";
import type { Session } from "../session.js";
import type { Seat, Occupant } from "../seat.js";
import { seatKey } from "../seat.js";

// A minimal seat: the scheduler reads role/index/occupant and passes the seat to variant.tick. The
// signer/address are never touched by the scheduler loop, so they are stubbed.
function makeSeat(role: Seat["role"], index: number, occupant: Occupant): Seat {
  return { role, index, occupant, address: `r${role}${index}`, signer: {} as Seat["signer"] };
}

// A fake ledger_current index that advances by one on every request, so the scheduler's inter-round
// waitForLedgerAdvance resolves immediately instead of idling out to its (test-irrelevant) timeout.
function fakeClient(): Session["client"] {
  let idx = 1000;
  return {
    request: async (req: { command: string }) => {
      if (req.command === "ledger_current") return { result: { ledger_current_index: idx++ } };
      throw new Error(`unexpected request in scheduler test: ${req.command}`);
    },
  } as unknown as Session["client"];
}

// A fake session carrying only what the scheduler uses: the seats map, and a fake client for the
// inter-round ledger wait (variants read state through their own stubs, not this client).
function makeSession(seats: Seat[]): Session {
  const map = new Map<string, Seat>();
  for (const s of seats) map.set(seatKey(s.role, s.index), s);
  return { seats: map, client: fakeClient() } as unknown as Session;
}

// A variant that records each tick and (optionally) mutates seat occupancy or stops the run, so a test
// can script exactly what happens across rounds without real timing.
function recordingVariant(role: BotVariant["role"], onTick: (calls: number) => StepOutcome | void): { variant: BotVariant; calls: number[] } {
  const state = { calls: [] as number[] };
  let n = 0;
  const variant: BotVariant = {
    role,
    name: `test-${role}`,
    async tick() {
      n++;
      state.calls.push(n);
      return (onTick(n) ?? { acted: false }) as StepOutcome;
    },
  };
  return { variant, calls: state.calls };
}

const opts = (assignment: Map<string, BotVariant>, extra: Partial<SchedulerOptions> = {}): SchedulerOptions => ({
  variants: [],
  assignment,
  intervalSeconds: 0, // no sleep between rounds
  ...extra,
});

describe("BotScheduler seat re-fill (bot-seat-reclaim)", () => {
  it("re-drives a seat that was released to 'open' mid-run", async () => {
    // owner seat starts bot-driven; on round 1 it is released (occupant -> open) to simulate a human
    // taking then releasing it. The self-heal must re-fill it so the variant ticks again after release.
    const owner = makeSeat("owner", 0, { kind: "bot" });
    const session = makeSession([owner]);

    const { variant, calls } = recordingVariant("owner", (n) => {
      if (n === 1) owner.occupant = { kind: "open" }; // released right after its first tick
      if (n >= 3) { scheduler.stop(); }               // let it run a few rounds then stop
      return { acted: false };
    });
    const assignment = new Map([[seatKey("owner", 0), variant]]);
    const scheduler = new BotScheduler(session, opts(assignment));

    await scheduler.run();

    // Ticked round 1 (bot), released to open, then re-filled and ticked again on rounds 2+ .
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // After the run the seat is bot-driven again (re-filled), not left open.
    expect(owner.occupant.kind).toBe("bot");
  });

  it("does NOT re-drive a seat a human still holds", async () => {
    // owner held by a human the whole run: the self-heal must never promote a human seat to bot.
    const owner = makeSeat("owner", 0, { kind: "human", id: "alice" });
    const session = makeSession([owner]);
    const { variant, calls } = recordingVariant("owner", () => undefined);
    const assignment = new Map([[seatKey("owner", 0), variant]]);
    const scheduler = new BotScheduler(session, opts(assignment, { maxRounds: 3 }));

    await scheduler.run();

    expect(calls.length).toBe(0);                 // human seat never driven
    expect(owner.occupant.kind).toBe("human");    // and never re-filled
  });

  it("does NOT promote an 'open' seat that has no assigned variant", async () => {
    // issuer seats get no variant; releasing one must not turn it into a bot seat.
    const issuer = makeSeat("issuer", 0, { kind: "open" });
    const depositor = makeSeat("depositor", 0, { kind: "bot" });
    const session = makeSession([issuer, depositor]);
    const { variant } = recordingVariant("depositor", (n) => (n >= 2 ? void scheduler.stop() : undefined));
    const assignment = new Map([[seatKey("depositor", 0), variant]]); // issuer intentionally absent
    const scheduler = new BotScheduler(session, opts(assignment));

    await scheduler.run();

    expect(issuer.occupant.kind).toBe("open"); // unassigned seat left open
  });

  it("clears a seat's stand-down state when it is re-filled after release", async () => {
    // A depositor stands down (3 identical rejections) and is skipped thereafter. A SECOND seat (owner)
    // drives the rounds; once the depositor has stood down, the owner variant releases it to "open".
    // The self-heal must re-fill the depositor AND clear its exhausted state, so it acts again — proving
    // the exhausted/lastReject bookkeeping is cleared on the open->bot flip.
    const dep = makeSeat("depositor", 0, { kind: "bot" });
    const owner = makeSeat("owner", 0, { kind: "bot" });
    const session = makeSession([dep, owner]);

    const depTicks: number[] = [];
    const depVariant: BotVariant = {
      role: "depositor",
      name: "test-dep",
      async tick() {
        depTicks.push(depTicks.length + 1);
        return { acted: true, action: "deposit", result: "tecUNFUNDED" }; // always the same rejection
      },
    };
    // owner drives the timeline: after the depositor has clearly stood down (round 5), release it; a few
    // rounds later, stop.
    let ownerRound = 0;
    const ownerVariant: BotVariant = {
      role: "owner",
      name: "test-owner",
      async tick() {
        ownerRound++;
        if (ownerRound === 5) dep.occupant = { kind: "open" }; // release the stood-down depositor
        if (ownerRound >= 8) scheduler.stop();
        return { acted: false };
      },
    };
    const assignment = new Map<string, BotVariant>([
      [seatKey("depositor", 0), depVariant],
      [seatKey("owner", 0), ownerVariant],
    ]);
    const scheduler = new BotScheduler(session, opts(assignment));

    await scheduler.run();

    // Depositor stood down after 3 identical rejections (ticks 1-3), was skipped for a round or two,
    // then released at owner-round 5, re-filled, and ticked AGAIN — so it accumulates more than 3 ticks.
    expect(depTicks.length).toBeGreaterThan(3);
    expect(dep.occupant.kind).toBe("bot"); // re-filled, not left open
  });

  it("stops when every assigned seat is human-held (no reclaimable work)", async () => {
    // Regression for the allExhausted change: a pool whose only assigned seat is human-held has no work
    // — no open reclaimable seat, no bot seat — so run() must return, not spin forever.
    const owner = makeSeat("owner", 0, { kind: "human", id: "alice" });
    const session = makeSession([owner]);
    const { variant, calls } = recordingVariant("owner", () => undefined);
    const assignment = new Map([[seatKey("owner", 0), variant]]);
    const scheduler = new BotScheduler(session, opts(assignment));

    // No maxRounds and no stop() call: this only terminates if allExhausted correctly reports "done"
    // for an all-human pool. A 1s timeout guards against a regression that would spin forever.
    await Promise.race([
      scheduler.run(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("scheduler did not stop for all-human pool")), 1000)),
    ]);

    expect(calls.length).toBe(0); // human seat never driven
  });
});
