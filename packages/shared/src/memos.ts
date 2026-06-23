import { createHash, randomBytes } from "node:crypto";

// Every transaction the harness submits carries two tags in its Memos:
//   - a setup id, identifying the whole provisioned environment, and
//   - a correlation id, identifying the single logical action that produced the transaction.
// Together they let an off-chain reader reconstruct which run and which step any transaction
// belongs to, even across a ledger reset that wipes on-chain history.

const SETUP_MEMO_TYPE = "setup-id";
const CORRELATION_MEMO_TYPE = "correlation-id";

export interface Memo {
  Memo: {
    MemoType?: string;
    MemoData?: string;
    MemoFormat?: string;
  };
}

const toHex = (s: string): string => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const fromHex = (h: string): string => Buffer.from(h, "hex").toString("utf8");

// Build the Memos array stamped on a transaction for a given setup and action.
export function buildMemos(setupId: string, correlationId: string): Memo[] {
  return [
    { Memo: { MemoType: toHex(SETUP_MEMO_TYPE), MemoData: toHex(setupId), MemoFormat: toHex("text/plain") } },
    { Memo: { MemoType: toHex(CORRELATION_MEMO_TYPE), MemoData: toHex(correlationId), MemoFormat: toHex("text/plain") } },
  ];
}

// Read the setup and correlation ids back out of a transaction's Memos, if present.
export function readMemos(memos: Memo[] | undefined): { setupId?: string; correlationId?: string } {
  const out: { setupId?: string; correlationId?: string } = {};
  for (const m of memos ?? []) {
    const type = m.Memo.MemoType ? fromHex(m.Memo.MemoType) : "";
    const data = m.Memo.MemoData ? fromHex(m.Memo.MemoData) : "";
    if (type === SETUP_MEMO_TYPE) out.setupId = data;
    else if (type === CORRELATION_MEMO_TYPE) out.correlationId = data;
  }
  return out;
}

// Generate a fresh, collision-resistant setup id when config does not pin one.
export function generateSetupId(): string {
  return `setup-${randomBytes(6).toString("hex")}`;
}

// A stable correlation id for a named action. Deriving it from the setup id plus the action name
// keeps it reproducible across re-runs, so replaying the same step yields the same id.
export function correlationId(setupId: string, action: string): string {
  const digest = createHash("sha256").update(`${setupId}\0${action}`).digest("hex").slice(0, 12);
  return `${action}-${digest}`;
}
