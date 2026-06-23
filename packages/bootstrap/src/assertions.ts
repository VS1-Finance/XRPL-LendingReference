import { accountObjects } from "@lending/shared";
import type { Client } from "xrpl";

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

// A single account owns both the vault and the broker. A separate originator account is not
// created; the broker must report the same owner as the vault, or the object graph is wrong.
export async function assertSingleOwner(client: Client, owner: string): Promise<void> {
  const vaults = await accountObjects(client, owner, "vault");
  const brokers = await accountObjects(client, owner, "loan_broker");
  const vault = vaults[0];
  const broker = brokers[0];
  if (!vault) throw new InvariantError("no vault found under the owner account");
  if (!broker) throw new InvariantError("no loan broker found under the owner account");

  const vaultOwner = (vault.Owner as string | undefined) ?? owner;
  const brokerOwner = (broker.Owner as string | undefined) ?? owner;
  if (brokerOwner !== vaultOwner) {
    throw new InvariantError(`broker owner ${brokerOwner} does not match vault owner ${vaultOwner}`);
  }
}

// First-loss cover must clear the broker's minimum cover requirement once seeded. The minimum is
// expressed as a scaled rate; cover and the requirement are compared in asset units here using the
// configured amount, with the on-ledger cover read back as the source of truth.
export async function assertCoverMeetsMinimum(
  client: Client,
  owner: string,
  expectedMinimum: string,
): Promise<{ cover: string }> {
  const brokers = await accountObjects(client, owner, "loan_broker");
  const broker = brokers[0];
  if (!broker) throw new InvariantError("no loan broker found under the owner account");

  const cover = readAmount(broker.CoverAvailable);
  if (Number(cover) < Number(expectedMinimum)) {
    throw new InvariantError(`broker cover ${cover} is below the required ${expectedMinimum}`);
  }
  return { cover };
}

function readAmount(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) return String((value as { value: unknown }).value);
  return "0";
}
