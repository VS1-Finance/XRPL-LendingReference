import { connect, type Config } from "@lending/shared";
import { provision, type ProvisionedEnvironment } from "@lending/bootstrap";
import { allCases } from "./cases/index.js";
import { resolveWallets } from "./context.js";
import { evaluate } from "./assert.js";
import type { CaseContext, CaseResult, NegativeCase, SuiteResult } from "./types.js";

// Cases that originate a loan need a broker with no active loan. Since a broker holds one loan at a
// time on this build, each of these runs against its own freshly provisioned environment; the rest
// share one base environment.
const LOAN_ORIGINATING = new Set(["N11", "N12", "N13", "N14", "N15"]);

export interface RunnerOptions {
  config: Config;
  log?: (msg: string) => void;
  // Restrict the run to specific case ids (default: all).
  only?: string[];
}

// Provision environments and run the negative-test catalogue, asserting each case's observed outcome
// against its expectation. Returns the collected results.
export async function runSuite(options: RunnerOptions): Promise<SuiteResult> {
  const log = options.log ?? (() => {});
  const cases = options.only ? allCases.filter((c) => options.only!.includes(c.id)) : allCases;
  const baseCases = cases.filter((c) => !LOAN_ORIGINATING.has(c.id));
  const loanCases = cases.filter((c) => LOAN_ORIGINATING.has(c.id));

  const results: CaseResult[] = [];
  const network = options.config.network;
  // A per-run nonce keeps each run's derived accounts distinct, so re-running the suite never
  // collides with leftover state (e.g. a loan left active) from a previous run's accounts.
  const seed = `${options.config.seed}-${runNonce()}`;

  // Base environment for the non-loan cases. A second depositor lets the revocation case (N4)
  // revoke a spare without disturbing the others.
  if (baseCases.length) {
    log("provisioning base environment for credential and vault cases");
    const env = await provisionFor(options.config, `${seed}-base`, "neg-base");
    const client = await connect(network);
    try {
      const ctx = context(client, env, `${seed}-base`);
      for (const c of baseCases) results.push(await runOne(c, ctx, log));
    } finally {
      await client.disconnect();
    }
  }

  // Each loan-originating case gets its own environment.
  for (const c of loanCases) {
    log(`provisioning dedicated environment for ${c.id}`);
    const caseSeed = `${seed}-${c.id.toLowerCase()}`;
    const env = await provisionFor(options.config, caseSeed, `neg-${c.id.toLowerCase()}`);
    const client = await connect(network);
    try {
      const ctx = context(client, env, caseSeed);
      results.push(await runOne(c, ctx, log));
    } finally {
      await client.disconnect();
    }
  }

  // Restore catalogue order: group by id prefix (N before P), then by number within each group, so
  // e.g. P1 does not collide with N1 once both prefixes are in play.
  results.sort((a, b) => a.id.replace(/\d/g, "").localeCompare(b.id.replace(/\d/g, "")) || caseNumber(a.id) - caseNumber(b.id));

  const ran = results.filter((r) => !r.skipped && r.expected.kind !== "deferred").length;
  const passed = results.filter((r) => r.pass && !r.skipped && r.expected.kind !== "deferred").length;
  const deferred = results.filter((r) => !r.skipped && r.expected.kind === "deferred").length;
  const skipped = results.filter((r) => r.skipped).length;
  return { setupId: `${seed}-base`, network, ran, passed, deferred, skipped, results };
}

async function runOne(c: NegativeCase, ctx: CaseContext, log: (m: string) => void): Promise<CaseResult> {
  // A case that does not apply to this environment (e.g. a domain-gate case against a public vault) is
  // reported as skipped and not counted — so the same catalogue stays honest across both vault modes.
  if (c.appliesTo && !c.appliesTo(ctx.env)) {
    log(`${c.id.padEnd(4)} skip ${c.title} — not applicable to this vault mode`);
    return { id: c.id, title: c.title, guards: c.guards, expected: c.expected, observed: { code: "SKIPPED" }, pass: true, skipped: true };
  }
  try {
    const observed = await c.run(ctx);
    const pass = evaluate(c.expected, observed);
    log(`${c.id.padEnd(4)} ${pass ? "ok  " : "FAIL"} ${c.title} — observed ${observed.code}`);
    return { id: c.id, title: c.title, guards: c.guards, expected: c.expected, observed, pass };
  } catch (err) {
    const observed = { code: "ERROR", detail: err instanceof Error ? err.message : String(err) };
    log(`${c.id.padEnd(4)} ERR  ${c.title} — ${observed.detail}`);
    return { id: c.id, title: c.title, guards: c.guards, expected: c.expected, observed, pass: false };
  }
}

async function provisionFor(base: Config, seed: string, setupId: string): Promise<ProvisionedEnvironment> {
  // Ensure at least two depositors so the revocation case has a spare. A short subscription window
  // (vs. the 180s default) lets waitForInvestmentPhase (helpers.ts) cross into Investment in a couple
  // of ledgers rather than minutes — this only affects suite wall-clock, not correctness.
  const config: Config = {
    ...base,
    seed,
    setupId,
    subscriptionWindowSeconds: 20,
    pool: { depositors: Math.max(2, base.pool.depositors), borrowers: Math.max(1, base.pool.borrowers) },
  };
  return provision(config, {});
}

function context(client: Awaited<ReturnType<typeof connect>>, env: ProvisionedEnvironment, seed: string): CaseContext {
  return { client, env, wallets: resolveWallets(env, seed) };
}

function caseNumber(id: string): number {
  return Number(id.replace(/\D/g, "")) || 0;
}

// A short, unique-per-run token. Derived from the wall clock and process id so each invocation
// provisions fresh accounts and never reuses a prior run's (possibly stuck) state.
function runNonce(): string {
  return `${Date.now().toString(36)}${(process.pid % 1000).toString(36)}`;
}
