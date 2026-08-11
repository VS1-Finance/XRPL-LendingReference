import { dropsToXrpString, scaledToDecimal } from "@lending/shared";
import type { Session } from "@lending/session";

// A participant account's on-ledger holdings, read live from the validated ledger: its XRP, the vault
// asset it holds (for an IOU or MPT vault), and the vault shares it holds. This is what the wallet UI
// renders.
export interface AccountBalance {
  seat: string;
  role: string;
  address: string;
  xrp: string;
  assetHeld: string;
  shares: string;
}

export interface SessionBalances {
  asset: string;
  accounts: AccountBalance[];
}

// Read balances for every seat account in one pass. Composes three validated-ledger reads per account;
// an account that is not yet funded on-ledger reads as all-zero rather than throwing.
export async function readBalances(session: Session): Promise<SessionBalances> {
  const { currency, issuer } = session.env.asset;
  const isXrp = currency === "XRP" && !issuer;
  const isMpt = currency === "MPT";
  const assetMptId = session.env.objects.assetMptId;
  const shareMptId = session.env.objects.shareMptId;

  const seats = [...session.seats.values()];
  const accounts = await Promise.all(
    seats.map(async (seat) => {
      const [xrp, assetHeld, shares] = await Promise.all([
        readXrp(session, seat.address),
        isMpt
          ? assetMptId
            ? readMptAsset(session, seat.address, assetMptId)
            : Promise.resolve("0")
          : isXrp || !issuer
            ? Promise.resolve("0")
            : readIssued(session, seat.address, currency, issuer),
        shareMptId ? readShares(session, seat.address, shareMptId) : Promise.resolve("0"),
      ]);
      return { seat: `${seat.role}:${seat.index}`, role: seat.role, address: seat.address, xrp, assetHeld, shares };
    }),
  );
  return { asset: currency, accounts };
}

// XRP balance as whole XRP. A not-yet-created account reads as "0".
async function readXrp(session: Session, address: string): Promise<string> {
  try {
    const res = await session.client.request({ command: "account_info", account: address, ledger_index: "validated" });
    return dropsToXrpString(String(res.result.account_data.Balance));
  } catch (err) {
    if (isAccountNotFound(err)) return "0";
    throw err;
  }
}

// The holder's balance of the vault's issued asset, from its trust line to the issuer.
async function readIssued(session: Session, holder: string, currency: string, issuer: string): Promise<string> {
  try {
    const res = await session.client.request({ command: "account_lines", account: holder, peer: issuer, ledger_index: "validated" });
    const line = (res.result.lines as { currency: string; balance: string }[]).find((l) => l.currency === currency);
    return line?.balance ?? "0";
  } catch (err) {
    if (isAccountNotFound(err)) return "0";
    throw err;
  }
}

// The holder's balance of the vault's MPT asset, as a whole-token decimal string (the raw on-ledger
// MPTAmount is a base-unit integer at the vault's actual assetScale — read back from env, since the
// vault could have been provisioned at any scale — scaled down to match the IOU display convention
// readIssued uses).
async function readMptAsset(session: Session, holder: string, assetMptId: string): Promise<string> {
  try {
    const res = await session.client.request({ command: "account_objects", account: holder, type: "mptoken", ledger_index: "validated" });
    const objs = res.result.account_objects as unknown as Record<string, unknown>[];
    const held = objs.find((o) => o.MPTokenIssuanceID === assetMptId);
    const raw = (held?.MPTAmount as string | undefined) ?? "0";
    const scale = session.env.objects.assetScale ?? 2;
    return scaledToDecimal(BigInt(raw), scale);
  } catch (err) {
    if (isAccountNotFound(err)) return "0";
    throw err;
  }
}

// The holder's balance of the vault's share MPT, in base units.
async function readShares(session: Session, holder: string, shareMptId: string): Promise<string> {
  try {
    const res = await session.client.request({ command: "account_objects", account: holder, type: "mptoken", ledger_index: "validated" });
    const objs = res.result.account_objects as unknown as Record<string, unknown>[];
    const share = objs.find((o) => o.MPTokenIssuanceID === shareMptId);
    return String((share?.MPTAmount as string | undefined) ?? "0");
  } catch (err) {
    if (isAccountNotFound(err)) return "0";
    throw err;
  }
}

function isAccountNotFound(err: unknown): boolean {
  const code = (err as { data?: { error?: string } })?.data?.error;
  return code === "actNotFound" || /actnotfound|account not found/i.test(String((err as { message?: string })?.message ?? err));
}
