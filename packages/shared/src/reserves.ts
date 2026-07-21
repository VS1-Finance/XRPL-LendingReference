import { Client } from "xrpl";
import type { Role } from "./accounts.js";

// XRP reserve economics. An account must hold a base reserve plus an increment for every ledger object
// it owns; that XRP is locked, not spent. Rather than bulk-funding every account with a flat amount,
// each role is funded for the reserve it will actually need — the base, plus the increment times the
// objects that role ends up owning — with a little headroom for transaction fees. This makes the raw
// accounts legible: inspecting them shows each holding roughly its minimum, the signal reviewers look
// for. The issuer and credential issuer own no reserved objects and so are funded minimally.

// The live reserve rates, in drops. Read from server_state (authoritative integer drops) rather than
// server_info (which reports XRP as floats).
export interface ReserveRates {
  baseDrops: number;
  incDrops: number;
}

export async function readReserveRates(client: Client): Promise<ReserveRates> {
  const res = await client.request({ command: "server_state" });
  const ledger = res.result.state.validated_ledger;
  if (!ledger || ledger.reserve_base === undefined || ledger.reserve_inc === undefined) {
    throw new Error("server_state did not report reserve_base/reserve_inc");
  }
  return { baseDrops: Number(ledger.reserve_base), incDrops: Number(ledger.reserve_inc) };
}

// The shape of the vault that determines how many objects each role owns.
export interface VaultShape {
  // Native XRP (no trust lines) versus an issued token (each holder and the owner hold a trust line).
  isXrp: boolean;
  // A permissioned vault gates access with a domain and per-holder credentials.
  permissioned: boolean;
}

// The peak number of reserved owner-count units a role holds over a full lifecycle. This is the ledger's
// OwnerCount (which drives the reserve), not the number of visible account_objects — some objects reserve
// more than one unit. Calibrated against live devnet OwnerCounts:
//   - currency issuer: 0 — the issuer side of a default-ripple trust line is not reserved by the issuer,
//     and it owns no vault objects.
//   - credential issuer: 0 — credentials are reserved on the subject, not the issuer.
//   - owner: measured 7 for an IOU permissioned vault. The vault reserves the vault object plus its share
//     MPTokenIssuance and the owner's own MPToken; the broker reserves the broker plus its cover; plus the
//     domain (permissioned) and a trust line (IOU). Counted as 5 base owner-units + domain + trust line.
//   - depositor: a credential (permissioned) + a trust line (IOU) + the share MPToken (after depositing).
//   - borrower: a credential (permissioned) + a trust line (IOU) + the loan (which reserves two units).
function peakObjectCount(role: Role, shape: VaultShape): number {
  const cred = shape.permissioned ? 1 : 0;
  const trustLine = shape.isXrp ? 0 : 1;
  switch (role) {
    case "issuer":
    case "credentialIssuer":
      return 0;
    case "owner":
      // vault (+ its share issuance) + broker (+ its cover) + owner's share MPToken = 5 units, plus the
      // domain and a trust line where they apply. Matches the measured OwnerCount of 7 for IOU permissioned.
      return 5 + (shape.permissioned ? 1 : 0) + trustLine;
    case "depositor":
      // credential + trust line + share MPToken.
      return cred + trustLine + 1;
    case "borrower":
      // credential + trust line + loan (reserves two units).
      return cred + trustLine + 2;
  }
}

// Fee headroom above the reserve, in drops. A handful of transactions at ~10 drops each is a tiny
// amount; 2 XRP keeps every account comfortably able to pay its own fees without over-funding.
const FEE_HEADROOM_DROPS = 2_000_000;

// The minimum drops to fund a role so it can hold its objects (reserve) and pay its fees, for the given
// vault shape and live reserve rates. This is the reserve floor; a caller adds any liquidity the role
// must additionally hold (an XRP holder funds the amount it deposits on top of this). Kept in integer
// drops throughout — funding sums many of these, and rounding to XRP first would accumulate floating-
// point error that the ledger's drops conversion then rejects.
export function roleReserveDrops(role: Role, shape: VaultShape, rates: ReserveRates): number {
  return rates.baseDrops + rates.incDrops * peakObjectCount(role, shape) + FEE_HEADROOM_DROPS;
}
