import { connect } from "@lending/shared";
import { deposit } from "./deposit.js";
import { originate, type LoanTerms } from "./originate.js";
import { repay } from "./repay.js";
import { close, readVaultAssets } from "./close.js";
import { resolveEnvironment } from "./environment.js";
import type { LifecycleRun, LifecycleStep, ProvisionedEnvironment } from "./types.js";

export interface RunOptions {
  seed: string;
  depositAmount: string;
  terms: LoanTerms;
  intervalSeconds: number;
  // Optional hook invoked instead of repayment, so an alternative branch (such as a defaulted
  // loan) can be driven from the same runner once its driver is supplied. When absent, the loan is
  // repaid and closed.
  branch?: LoanBranch;
  log?: (msg: string) => void;
}

// A pluggable terminal branch for an originated loan. The default branch (repay + close) is built
// in; this seam lets other terminal behaviours reuse deposit and origination unchanged.
export interface LoanBranch {
  name: string;
  run(ctx: BranchContext): Promise<{ steps: LifecycleStep[]; reachedRepaid: boolean; closed: boolean }>;
}

export interface BranchContext {
  client: Awaited<ReturnType<typeof connect>>;
  env: ProvisionedEnvironment;
  resolved: ReturnType<typeof resolveEnvironment>;
  loanId: string;
  startSeq: number;
  intervalSeconds: number;
}

// Run one complete loan lifecycle against a provisioned environment: a single depositor deposits,
// a single loan is originated bilaterally, then the terminal branch runs (repay + close by
// default). Returns the ordered, correlation-tagged step record.
export async function runLifecycle(env: ProvisionedEnvironment, options: RunOptions): Promise<LifecycleRun> {
  const log = options.log ?? (() => {});
  const resolved = resolveEnvironment(env, options.seed);
  const depositor = resolved.depositors[0]!;
  const owner = resolved.owner;
  const borrower = resolved.borrowers[0]!;

  const steps: LifecycleStep[] = [];
  const client = await connect(env.network);
  try {
    log(`lifecycle for ${env.setupId} on ${env.network}`);

    const assetsBefore = await readVaultAssets(client, owner.account.address);

    const dep = await deposit(client, env, depositor, options.depositAmount, steps.length + 1);
    steps.push(dep.step);
    log(`deposit — ${dep.step.result} (shares minted ${dep.sharesMinted})`);

    const orig = await originate(client, env, owner, borrower, options.terms, steps.length + 1);
    steps.push(orig.step);
    log(`originate — ${orig.step.result} (loan ${orig.loanId.slice(0, 12)}…)`);

    const branch = options.branch ?? defaultBranch;
    const outcome = await branch.run({ client, env, resolved, loanId: orig.loanId, startSeq: steps.length + 1, intervalSeconds: options.intervalSeconds });
    steps.push(...outcome.steps);
    log(`${branch.name} — repaid=${outcome.reachedRepaid} closed=${outcome.closed}`);

    const assetsAfter = await readVaultAssets(client, owner.account.address);
    log(`vault assets ${assetsBefore ?? "?"} -> ${assetsAfter ?? "?"} (depositor yield reflected on-chain)`);

    return { setupId: env.setupId, network: env.network, loanId: orig.loanId, reachedRepaid: outcome.reachedRepaid, closed: outcome.closed, steps };
  } finally {
    await client.disconnect();
  }
}

// The built-in terminal branch: repay the loan on schedule, then close it.
const defaultBranch: LoanBranch = {
  name: "repay-and-close",
  async run(ctx) {
    const borrower = ctx.resolved.borrowers[0]!;
    const owner = ctx.resolved.owner;
    const repaid = await repay(ctx.client, ctx.env, borrower, ctx.loanId, ctx.startSeq, { intervalSeconds: ctx.intervalSeconds });
    const closeResult = await close(ctx.client, ctx.env, owner, ctx.loanId, ctx.startSeq + repaid.steps.length);
    const steps = closeResult.step ? [...repaid.steps, closeResult.step] : repaid.steps;
    return { steps, reachedRepaid: repaid.reachedRepaid, closed: closeResult.closed };
  },
};
