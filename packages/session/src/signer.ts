import type { Client, SubmittableTransaction, Wallet } from "xrpl";

export interface SubmitResult {
  hash: string;
  engineResult: string;
}

// How a seat's account authorizes and submits a transaction. Every seat holds a signer and does not
// care how the signing happens — a bot-driven seat and a human-driven seat both act through this
// same surface. The only implementation today signs with a locally held key; a signer backed by an
// external wallet would implement the same shape without any change to callers.
export interface Signer {
  readonly address: string;
  submit(tx: SubmittableTransaction): Promise<SubmitResult>;
}

// A signer that holds the account's key directly and signs server-side. This is the identity used
// for seats whose key is derived from the session seed — both bot-driven seats and, for now,
// human-driven ones acting through the backend.
export class ServerSigner implements Signer {
  constructor(private readonly client: Client, private readonly wallet: Wallet) {}

  get address(): string {
    return this.wallet.address;
  }

  async submit(tx: SubmittableTransaction): Promise<SubmitResult> {
    const prepared = await this.client.autofill(tx);
    const res = await this.client.submitAndWait(this.wallet.sign(prepared).tx_blob);
    const meta = res.result.meta;
    const engineResult = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
    return { hash: res.result.hash, engineResult };
  }
}
