import type { Client } from "xrpl";
import type { ProvisionedEnvironment } from "@lending/bootstrap";
import type { ResolvedWallets } from "./context.js";

// What a negative case expects. Most cases expect the ledger to reject an action with a specific
// engine result code. A few are correctness cases: the action succeeds, and a value is checked
// instead of a rejection. One case (issuer rotation) is deferred pending a protocol decision and is
// reported without being run.
export type Expectation =
  | { kind: "reject"; code: string }
  | { kind: "reject-any"; codes: string[] }
  | { kind: "success"; note: string }
  | { kind: "deferred"; reason: string };

// The context handed to each case: a live client, the provisioned environment, and the resolved
// signing wallets for its accounts.
export interface CaseContext {
  client: Client;
  env: ProvisionedEnvironment;
  wallets: ResolvedWallets;
}

// The observed outcome of running a case's action.
export interface Observed {
  code: string;
  txHash?: string;
  detail?: string;
}

export interface NegativeCase {
  id: string;
  title: string;
  // The invariant or protocol property this case guards.
  guards: string;
  expected: Expectation;
  // Run the case's action and report what the ledger did. Setup that a case needs beyond the base
  // environment is performed inside run().
  run(ctx: CaseContext): Promise<Observed>;
}

export interface CaseResult {
  id: string;
  title: string;
  guards: string;
  expected: Expectation;
  observed: Observed;
  pass: boolean;
}

export interface SuiteResult {
  setupId: string;
  network: string;
  ran: number;
  passed: number;
  deferred: number;
  results: CaseResult[];
}
