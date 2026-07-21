import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WatchedEnvironment } from "./subscriber.js";

// rippled reports a numeric network id per network; the store records it so a reset to a different
// network is distinguishable in the history.
const NETWORK_IDS: Record<string, string> = {
  devnet: "2",
  "wasm-devnet": "2002",
};

interface ProvisionedFile {
  setupId: string;
  network: "devnet" | "wasm-devnet";
  objects?: { shareMptId?: string };
  accounts: {
    issuer: { address: string };
    credentialIssuer?: { address: string };
    owner: { address: string };
    depositors: { address: string }[];
    borrowers: { address: string }[];
  };
}

// Read a provisioned environment graph and reduce it to the set of accounts the subscriber watches.
export function watchedFromProvisioned(path: string): WatchedEnvironment {
  const abs = resolve(path);
  const file = JSON.parse(readFileSync(abs, "utf8")) as ProvisionedFile;
  if (!file.setupId || !file.accounts?.owner?.address) {
    throw new Error(`provisioned file ${abs} is missing required fields`);
  }

  const accounts = [
    file.accounts.issuer.address,
    ...(file.accounts.credentialIssuer ? [file.accounts.credentialIssuer.address] : []),
    file.accounts.owner.address,
    ...file.accounts.depositors.map((a) => a.address),
    ...file.accounts.borrowers.map((a) => a.address),
  ];

  const env: WatchedEnvironment = {
    setupId: file.setupId,
    network: file.network,
    networkId: NETWORK_IDS[file.network] ?? "0",
    owner: file.accounts.owner.address,
    accounts,
  };
  if (file.objects?.shareMptId) env.shareMptId = file.objects.shareMptId;
  return env;
}
