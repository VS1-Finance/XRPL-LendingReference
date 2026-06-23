import { Client, Wallet, xrpToDrops, dropsToXrp } from "xrpl";
import type { DerivedAccount } from "./accounts.js";
import { withRetry } from "./retry.js";

export interface FanOutOptions {
  // XRP delivered to each target account that is short of the target balance.
  xrpPerAccount: number;
  // Treasury is funded to cover all targets plus headroom for fees and its own reserve. Bounded
  // by the per-account faucet grant, so very large pools fan out from multiple faucet grants.
  log?: (msg: string) => void;
}

export interface FundedAccount {
  account: DerivedAccount;
  fundedXrp: number;
  alreadyFunded: boolean;
  txHash?: string;
}

// The faucet grants a fixed amount per request and rate-limits aggressive callers, so pools are
// funded by fanning XRP out from a treasury rather than hitting the faucet once per account.
//
// Idempotent: an account already holding at least the target balance is skipped, so a re-run
// tops up only what is missing instead of double-funding.
export async function fanOutFunding(
  client: Client,
  treasury: Wallet,
  targets: DerivedAccount[],
  options: FanOutOptions,
): Promise<FundedAccount[]> {
  const log = options.log ?? (() => {});
  const targetDrops = BigInt(xrpToDrops(options.xrpPerAccount));
  const results: FundedAccount[] = [];

  for (const target of targets) {
    const balanceDrops = await accountBalanceDrops(client, target.address);
    if (balanceDrops >= targetDrops) {
      log(`fund ${target.role}[${target.index}] ${target.address} — already funded, skip`);
      results.push({ account: target, fundedXrp: Number(dropsToXrp(balanceDrops.toString())), alreadyFunded: true });
      continue;
    }

    const shortfall = targetDrops - balanceDrops;
    const hash = await withRetry(
      () => sendXrp(client, treasury, target.address, shortfall.toString()),
      {
        retryable: isTransient,
        onRetry: (err, attempt, delay) =>
          log(`fund ${target.address} attempt ${attempt} failed (${describe(err)}); retrying in ${delay}ms`),
      },
    );
    log(`fund ${target.role}[${target.index}] ${target.address} — sent ${dropsToXrp(shortfall.toString())} XRP`);
    results.push({ account: target, fundedXrp: options.xrpPerAccount, alreadyFunded: false, txHash: hash });
  }

  return results;
}

// Fund the treasury from the network faucet. The faucet creates and funds a fresh account; the
// returned wallet seeds the fan-out. Retried with backoff because the faucet is rate-limited.
export async function fundTreasury(client: Client, log: (msg: string) => void = () => {}): Promise<Wallet> {
  const { wallet, balance } = await withRetry(() => client.fundWallet(), {
    retryable: isTransient,
    onRetry: (err, attempt, delay) => log(`faucet attempt ${attempt} failed (${describe(err)}); retrying in ${delay}ms`),
  });
  log(`treasury ${wallet.address} funded with ${balance} XRP`);
  return wallet;
}

// Fund a treasury large enough to cover the whole fan-out. The faucet grants a fixed amount per
// request, so a treasury that needs more than one grant is topped up with repeated faucet calls
// into the same account until it holds the required total (plus headroom for fees and reserve).
export async function fundTreasuryForTargets(
  client: Client,
  targetCount: number,
  xrpPerAccount: number,
  log: (msg: string) => void = () => {},
): Promise<Wallet> {
  const headroomXrp = 20;
  const requiredDrops = BigInt(xrpToDrops(targetCount * xrpPerAccount + headroomXrp));
  const treasury = await fundTreasury(client, log);

  let balance = await accountBalanceDrops(client, treasury.address);
  let grants = 1;
  const maxGrants = targetCount + 4; // a safety bound so a stuck faucet cannot loop forever
  while (balance < requiredDrops && grants < maxGrants) {
    await withRetry(() => client.fundWallet(treasury), {
      retryable: isTransient,
      onRetry: (err, attempt, delay) => log(`faucet top-up attempt ${attempt} failed (${describe(err)}); retrying in ${delay}ms`),
    });
    grants++;
    balance = await accountBalanceDrops(client, treasury.address);
    log(`treasury topped up (grant ${grants}) — balance ${dropsToXrp(balance.toString())} XRP`);
  }

  if (balance < requiredDrops) {
    throw new Error(
      `treasury could not reach ${dropsToXrp(requiredDrops.toString())} XRP after ${grants} faucet grants ` +
        `(have ${dropsToXrp(balance.toString())}); lower fundingXrpPerAccount or pool size`,
    );
  }
  return treasury;
}

async function sendXrp(client: Client, from: Wallet, to: string, drops: string): Promise<string> {
  const prepared = await client.autofill({
    TransactionType: "Payment",
    Account: from.address,
    Destination: to,
    Amount: drops,
  });
  const res = await client.submitAndWait(from.sign(prepared).tx_blob);
  const meta = res.result.meta;
  const code = typeof meta === "object" && meta ? meta.TransactionResult : undefined;
  if (code !== "tesSUCCESS") {
    throw new Error(`funding payment to ${to} returned ${code ?? "unknown result"}`);
  }
  return res.result.hash;
}

async function accountBalanceDrops(client: Client, address: string): Promise<bigint> {
  try {
    const res = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    return BigInt(res.result.account_data.Balance);
  } catch (err) {
    // An unfunded account does not exist on ledger yet — treat as zero balance.
    if (isAccountNotFound(err)) return 0n;
    throw err;
  }
}

function isAccountNotFound(err: unknown): boolean {
  const code = (err as { data?: { error?: string } })?.data?.error;
  if (code === "actNotFound") return true;
  return /actnotfound|account not found/i.test(describe(err));
}

function isTransient(err: unknown): boolean {
  const msg = describe(err).toLowerCase();
  // Funded-result failures (tec/tef) are not retried; network, rate-limit and timeout errors are.
  if (msg.includes("returned tec") || msg.includes("returned tef")) return false;
  return (
    msg.includes("timeout") ||
    msg.includes("rate") ||
    msg.includes("429") ||
    msg.includes("econn") ||
    msg.includes("socket") ||
    msg.includes("network") ||
    msg.includes("disconnect") ||
    msg.includes("faucet")
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err) return JSON.stringify(err);
  return String(err);
}
