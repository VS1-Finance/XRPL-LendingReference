import { credentialCases } from "./credentials.js";
import { lendingCases } from "./lending.js";
import type { NegativeCase } from "../types.js";

// The full negative-test catalogue, in order. N6 is present but deferred (reported, not asserted).
export const allCases: NegativeCase[] = [...credentialCases, ...lendingCases];

export function caseById(id: string): NegativeCase | undefined {
  return allCases.find((c) => c.id === id);
}
