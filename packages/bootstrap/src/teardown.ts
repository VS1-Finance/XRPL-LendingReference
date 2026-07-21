import {
  type Network,
  connect,
  correlationId,
  deriveAccount,
  submit,
} from "@lending/shared";
import { encodeCredentialType } from "./ledger-lookups.js";
import { deleteEnvironment, loadEnvironment } from "./store.js";
import type { ProvisionedEnvironment } from "./types.js";

export interface TeardownOptions {
  seed: string;
  network?: Network;
  outDir?: string;
  log?: (msg: string) => void;
}

// Remove a provisioned environment scoped to its setup id: delete the broker, vault, domain and
// credentials in dependency order, then drop the stored graph. Best-effort — an object already
// gone (or wiped by a ledger reset) is skipped rather than failing the teardown.
export async function teardown(setupId: string, options: TeardownOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const env = loadEnvironment(setupId, options.outDir);
  if (!env) {
    log(`no stored environment for ${setupId}; nothing to tear down`);
    return;
  }

  const network = options.network ?? (env.network as Network);
  const owner = deriveAccount(options.seed, "owner", 0).wallet;
  const issuer = deriveAccount(options.seed, "issuer", 0).wallet;

  const client = await connect(network);
  try {
    const ctx = (action: string) => ({ setupId, correlationId: correlationId(setupId, `teardown-${action}`) });

    if (env.objects.brokerId) {
      await tryDelete(log, "broker", () =>
        submit(client, owner, { TransactionType: "LoanBrokerDelete", Account: owner.address, LoanBrokerID: env.objects.brokerId! }, ctx("broker")),
      );
    }
    if (env.objects.vaultId) {
      await tryDelete(log, "vault", () =>
        submit(client, owner, { TransactionType: "VaultDelete", Account: owner.address, VaultID: env.objects.vaultId! }, ctx("vault")),
      );
    }
    if (env.objects.domainId) {
      await tryDelete(log, "domain", () =>
        submit(client, owner, { TransactionType: "PermissionedDomainDelete", Account: owner.address, DomainID: env.objects.domainId! }, ctx("domain")),
      );
    }

    await deleteCredentials(client, issuer, env, log, ctx);

    deleteEnvironment(setupId, options.outDir);
    log(`removed stored environment for ${setupId}`);
  } finally {
    await client.disconnect();
  }
}

async function deleteCredentials(
  client: Parameters<typeof submit>[0],
  issuer: Parameters<typeof submit>[1],
  env: ProvisionedEnvironment,
  log: (msg: string) => void,
  ctx: (action: string) => { setupId: string; correlationId: string },
): Promise<void> {
  // A public vault issued no credentials, so there is nothing to remove.
  if (!env.credentialType) return;
  const credHex = encodeCredentialType(env.credentialType);
  for (const member of [...env.accounts.depositors, ...env.accounts.borrowers]) {
    await tryDelete(log, `credential ${member.role}[${member.index}]`, () =>
      submit(
        client,
        issuer,
        { TransactionType: "CredentialDelete", Account: issuer.address, Subject: member.address, CredentialType: credHex },
        ctx(`credential-${member.role}-${member.index}`),
      ),
    );
  }
}

async function tryDelete(log: (msg: string) => void, label: string, run: () => Promise<{ engineResult: string }>): Promise<void> {
  try {
    const r = await run();
    log(`delete ${label} — ${r.engineResult}`);
  } catch (err) {
    log(`delete ${label} — skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}
