import { signLoanSetByCounterparty, xrpToDrops } from "xrpl";
import type { Amount, MPTAmount, SubmittableTransaction } from "xrpl";
import { clampIssuedValueUp, decimalToScaled, deriveAccount } from "@lending/shared";
import type { Session } from "@lending/session";

export interface ActionRequest {
  seat: string;
  action: string;
  params?: Record<string, string>;
}

export interface ActionResult {
  action: string;
  code: string;
  hash?: string;
}

export class ActionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ActionError";
  }
}

// Turn a thrown ledger/xrpl error into a clean 400 when it is caused by the caller's input rather than
// an engine fault: xrpl's ValidationError (a malformed amount or transaction) and a preliminary `tem`
// rejection (the transaction never reaches a ledger) are the client's fault. Anything else — a dropped
// connection, an RPC fault, a genuinely unexpected error — is rethrown so it surfaces as a 500. Already
// an ActionError → passed through untouched. Without this, a bad `amount` string surfaces as an opaque
// 500 exactly like a real outage, which the two callers below cannot tell apart.
function asClientError(err: unknown): never {
  if (err instanceof ActionError) throw err;
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  // Client-caused failures: xrpl's ValidationError (malformed tx/amount), a preliminary `tem` rejection
  // (the tx never reached a ledger), and the amount-shape errors thrown while building the tx (an
  // "illegal amount" from the IOU serializer, clampIssuedValueUp's "not a non-negative decimal", or
  // decimalToScaled's "has more than N fractional digits" — thrown by the MPT branch of assetAmount/
  // brokerValue when a caller submits an amount with more precision than the vault asset's scale).
  if (
    name === "ValidationError" ||
    /Transaction failed, tem/.test(message) ||
    /illegal amount|not a non-negative decimal|invalid amount|has more than \d+ fractional digits/.test(message)
  ) {
    throw new ActionError(message, 400);
  }
  throw err;
}

// tfLoanDefault on LoanManage — the flag the owner sets to default a delinquent loan. This is the
// same transaction the broker-enforcer bot submits; exposing it as an owner action lets a human do by
// hand what the bot does automatically.
const TF_LOAN_DEFAULT = 65536;

// lsfLoanDefaulted on a Loan ledger object — set once a loan has been defaulted. A defaulted loan is no
// longer a live obligation, so it must not count toward the borrower's one-active-loan limit.
const LSF_LOAN_DEFAULTED = 0x00010000;

// Turns an API action request into an on-ledger transaction signed by the seat that owns it. A human
// action and a bot action reach the ledger the same way — through the seat's signer — so this is the
// single place a human's intent becomes a submission. The seat must be held by the requesting
// participant, which the caller checks before dispatching here.
export async function dispatchAction(session: Session, request: ActionRequest, participant: string): Promise<ActionResult> {
  const seat = session.seats.get(request.seat);
  if (!seat) throw new ActionError(`session has no seat ${request.seat}`, 404);
  if (seat.occupant.kind !== "human" || seat.occupant.id !== participant) {
    throw new ActionError(`${request.seat} is not held by ${participant}`, 409);
  }

  try {
    const tx = await buildTransaction(session, seat.address, request);
    const result = await seat.signer.submit(tx);
    return { action: request.action, code: result.engineResult, ...(result.hash ? { hash: result.hash } : {}) };
  } catch (err) {
    asClientError(err);
  }
}

async function buildTransaction(session: Session, account: string, request: ActionRequest): Promise<SubmittableTransaction> {
  const p = request.params ?? {};

  switch (request.action) {
    case "deposit":
      return {
        TransactionType: "VaultDeposit",
        Account: account,
        VaultID: session.env.objects.vaultId!,
        Amount: assetAmount(session, required(p, "amount")),
      };

    case "withdraw":
      return {
        TransactionType: "VaultWithdraw",
        Account: account,
        VaultID: session.env.objects.vaultId!,
        Amount: assetAmount(session, required(p, "amount")),
      };

    case "repay": {
      const loanId = required(p, "loanId");
      return {
        TransactionType: "LoanPay",
        Account: account,
        LoanID: loanId,
        Amount: assetAmount(session, clampIssuedValueUp(required(p, "amount"))),
      };
    }

    // Issuer actions: grant or revoke a credential for a subject account.
    case "issue-credential":
      return {
        TransactionType: "CredentialCreate",
        Account: account,
        Subject: required(p, "subject"),
        CredentialType: encodeCredentialType(resolveCredentialType(session, p)),
      };

    case "revoke-credential":
      return {
        TransactionType: "CredentialDelete",
        Account: account,
        Subject: required(p, "subject"),
        CredentialType: encodeCredentialType(resolveCredentialType(session, p)),
      };

    // Subject action: accept a credential the issuer created. A credential is inert until accepted, so
    // this is the second half of the two-party handshake — the acting seat accepts the credential the
    // issuer offered it.
    case "accept-credential":
      return {
        TransactionType: "CredentialAccept",
        Account: account,
        Issuer: p.issuer ?? resolveCredentialIssuer(session),
        CredentialType: encodeCredentialType(resolveCredentialType(session, p)),
      };

    // Vault-manager actions: adjust vault parameters, or swap the domain's accepted credentials.
    case "set-vault":
      return {
        TransactionType: "VaultSet",
        Account: account,
        VaultID: session.env.objects.vaultId!,
        // AssetsMaximum is in vault asset units — drops for XRP, whole tokens otherwise.
        ...(p.assetsMaximum ? { AssetsMaximum: brokerValue(session, p.assetsMaximum) } : {}),
      };

    case "set-domain": {
      // Swapping the accepted credentials only makes sense for a permissioned vault, which has a domain.
      const domainId = session.env.objects.domainId;
      if (!domainId) throw new ActionError("this session is a public vault and has no domain to configure", 409);
      return {
        TransactionType: "PermissionedDomainSet",
        Account: account,
        DomainID: domainId,
        AcceptedCredentials: [
          {
            Credential: {
              Issuer: p.issuer ?? resolveCredentialIssuer(session),
              CredentialType: encodeCredentialType(resolveCredentialType(session, p)),
            },
          },
        ],
      };
    }

    // Loan-originator action: default a delinquent loan. The owner does by hand what the
    // broker-enforcer bot does each round — set tfLoanDefault on a named loan.
    case "manage-loan":
      return {
        TransactionType: "LoanManage",
        Account: account,
        LoanID: required(p, "loanId"),
        Flags: TF_LOAN_DEFAULT,
      };

    // Owner action: add first-loss cover to the broker. Cover backs outstanding loans, so raising it
    // raises how much can be originated (loans must stay within the cover at the minimum cover rate).
    case "deposit-cover":
      return {
        TransactionType: "LoanBrokerCoverDeposit",
        Account: account,
        LoanBrokerID: session.env.objects.brokerId!,
        Amount: assetAmount(session, required(p, "amount")),
      };

    default:
      throw new ActionError(`unknown action ${request.action}`);
  }
}

// Origination is bilateral, so it does not fit the single-signer submit path and is handled here:
// the owner signs and the borrower counter-signs the same LoanSet. Called from the actions route for
// the owner's originate action.
export async function originate(session: Session, ownerSeatKey: string, params: Record<string, string>, participant: string): Promise<ActionResult> {
  const owner = session.seats.get(ownerSeatKey);
  if (!owner) throw new ActionError(`session has no seat ${ownerSeatKey}`, 404);
  if (owner.occupant.kind !== "human" || owner.occupant.id !== participant) {
    throw new ActionError(`${ownerSeatKey} is not held by ${participant}`, 409);
  }
  // Origination is owner-only: the signing wallets below are re-derived by role, so a non-owner seat
  // would sign with the wrong account (Account ≠ key) and the ledger would reject it opaquely. Guard
  // the roles here so a misdirected request is a clean rejection, not a 500.
  if (owner.role !== "owner") throw new ActionError("only the owner seat can originate a loan", 409);
  const borrowerSeat = session.seats.get(required(params, "borrower"));
  if (!borrowerSeat) throw new ActionError(`session has no seat ${params.borrower}`, 404);
  if (borrowerSeat.role !== "borrower") throw new ActionError(`${borrowerSeat.role} seat cannot be a loan counterparty`, 409);

  const term = paymentTotal(params.paymentTotal);
  const loanSet = {
    TransactionType: "LoanSet" as const,
    Account: owner.address,
    LoanBrokerID: session.env.objects.brokerId!,
    Counterparty: borrowerSeat.address,
    // The principal is in the broker's asset units — drops for XRP, whole tokens otherwise.
    PrincipalRequested: brokerValue(session, required(params, "principal")),
    InterestRate: Number(params.interestRate ?? 50000),
    PaymentInterval: Number(params.interval ?? 60),
    GracePeriod: Number(params.grace ?? 60),
    ...(term !== undefined ? { PaymentTotal: term } : {}),
    LoanOriginationFee: "0",
  };

  // Origination needs two raw signatures on one transaction, which the single-signer submit path does
  // not express, so the owner and borrower wallets are re-derived from the session seed for the
  // bilateral sign. The derived addresses match the seats, which is what binds the signatures to the
  // seats' identities.
  const ownerWallet = deriveAccount(session.seed, "owner", owner.index).wallet;
  const borrowerWallet = deriveAccount(session.seed, "borrower", borrowerSeat.index).wallet;
  try {
    const prepared = await session.client.autofill(loanSet);
    const ownerSigned = ownerWallet.sign(prepared);
    const combined = signLoanSetByCounterparty(borrowerWallet, ownerSigned.tx_blob);
    const res = await session.client.submitAndWait(combined.tx_blob);
    const meta = res.result.meta;
    const code = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
    return { action: "originate", code, hash: res.result.hash };
  } catch (err) {
    asClientError(err);
  }
}

// Borrower-initiated origination. Same bilateral LoanSet as originate() — Account is still the broker
// owner (the sender/first signer), Counterparty is the borrower — but the CALLER holds the borrower
// seat and the engine resolves the single owner seat itself, signing the owner's side on their behalf.
export async function requestLoan(session: Session, borrowerSeatKey: string, params: Record<string, string>, participant: string): Promise<ActionResult> {
  const borrowerSeat = session.seats.get(borrowerSeatKey);
  if (!borrowerSeat) throw new ActionError(`session has no seat ${borrowerSeatKey}`, 404);
  if (borrowerSeat.occupant.kind !== "human" || borrowerSeat.occupant.id !== participant) {
    throw new ActionError(`${borrowerSeatKey} is not held by ${participant}`, 409);
  }
  if (borrowerSeat.role !== "borrower") throw new ActionError("only a borrower seat can request a loan", 409);

  const owner = [...session.seats.values()].find((s) => s.role === "owner");
  if (!owner) throw new ActionError("session has no owner seat", 404);

  // One loan per borrower at a time: reject a request while the borrower still holds an ACTIVE loan.
  // A fully-repaid loan leaves a closed Loan husk on the borrower's account — the ledger zeroes out and
  // drops its balance fields (PaymentRemaining, TotalValueOutstanding) once it is paid off — so the mere
  // presence of a loan object does not mean the borrower owes anything. Count only loans that are still
  // live: not defaulted, and with payments still remaining. This mirrors the bots' payableLoan check, so
  // a borrower can request a new loan after settling the previous one.
  const existing = await session.client.request({
    command: "account_objects", account: borrowerSeat.address, type: "loan",
  });
  const active = existing.result.account_objects.filter((loan) => {
    const l = loan as unknown as Record<string, unknown>;
    const defaulted = (Number(l.Flags ?? 0) & LSF_LOAN_DEFAULTED) !== 0;
    return !defaulted && Number(l.PaymentRemaining ?? 0) > 0;
  });
  if (active.length > 0) {
    throw new ActionError("borrower already has an active loan", 409);
  }

  const term = paymentTotal(params.paymentTotal);
  const loanSet = {
    TransactionType: "LoanSet" as const,
    Account: owner.address,
    LoanBrokerID: session.env.objects.brokerId!,
    Counterparty: borrowerSeat.address,
    PrincipalRequested: brokerValue(session, required(params, "principal")),
    InterestRate: Number(params.interestRate ?? 50000),
    PaymentInterval: Number(params.interval ?? 60),
    GracePeriod: Number(params.grace ?? 60),
    ...(term !== undefined ? { PaymentTotal: term } : {}),
    LoanOriginationFee: "0",
  };

  // The owner index comes from the resolved owner seat and the borrower index from the caller's seat,
  // so both wallets bind to the right accounts. Owner signs first, borrower counter-signs — the same
  // bilateral order originate() uses; the engine holds both keys, so no human owner need be present.
  const ownerWallet = deriveAccount(session.seed, "owner", owner.index).wallet;
  const borrowerWallet = deriveAccount(session.seed, "borrower", borrowerSeat.index).wallet;
  try {
    const prepared = await session.client.autofill(loanSet);
    const ownerSigned = ownerWallet.sign(prepared);
    const combined = signLoanSetByCounterparty(borrowerWallet, ownerSigned.tx_blob);
    const res = await session.client.submitAndWait(combined.tx_blob);
    const meta = res.result.meta;
    const code = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
    return { action: "request-loan", code, hash: res.result.hash };
  } catch (err) {
    asClientError(err);
  }
}

// Whether the vault asset is native XRP (currency "XRP" with no issuer) rather than an issued token.
function isXrp(session: Session): boolean {
  const { currency, issuer } = session.env.asset;
  return currency === "XRP" && !issuer;
}

// Whether the vault asset is an MPT vault asset (currency "MPT", identified by env.objects.assetMptId
// rather than a currency/issuer pair).
function isMpt(session: Session): boolean {
  return session.env.asset.currency === "MPT";
}

// The scale the session's vault-asset MPT issuance was actually created at, read back from env (not
// config or a const — a session could have been provisioned at any scale). Actions carry whole-token
// request params and need this scale to shape a raw integer MPT amount from a whole-token value.
function mptAssetScale(session: Session): number {
  return session.env.objects.assetScale ?? 2;
}

// Builds a ledger Amount for the session's asset from a whole-token value. For XRP that is a bare drops
// string; for MPT it is an mpt_issuance_id/value object with the value scaled to the issuance's raw
// integer units; for an issued token it is a currency/issuer/value object. Every action that carries an
// amount goes through this, so every asset kind is handled in one place.
// A positive decimal string. Every asset kind ultimately rejects a non-numeric amount, but the XRP path
// throws xrpl's ValidationError while the IOU path throws an "illegal amount" serialization error deep
// in submit — different types, both surfacing as an opaque 500. Validating the shape here turns any bad
// amount into a clean 400 up front, regardless of vault kind.
function requireAmount(value: string): string {
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || Number(value) <= 0) {
    throw new ActionError(`invalid amount: ${value}`, 400);
  }
  return value;
}

function assetAmount(session: Session, value: string): Amount | MPTAmount {
  const v = requireAmount(value);
  if (isXrp(session)) return xrpToDrops(v);
  if (isMpt(session)) {
    const mptIssuanceId = session.env.objects.assetMptId;
    if (!mptIssuanceId) throw new ActionError("MPT asset has no assetMptId", 500);
    return { mpt_issuance_id: mptIssuanceId, value: decimalToScaled(v, mptAssetScale(session)).toString() };
  }
  const { currency, issuer } = session.env.asset;
  if (!issuer) throw new ActionError("issued asset has no issuer", 500);
  return { currency, issuer, value: v };
}

// A bare numeric value in the broker's asset units, for fields (loan principal, debt max) that take a
// plain number rather than a full Amount: drops for XRP, the issuance's raw integer units for MPT,
// whole tokens otherwise.
function brokerValue(session: Session, value: string): string {
  const v = requireAmount(value);
  if (isXrp(session)) return xrpToDrops(v);
  if (isMpt(session)) return decimalToScaled(v, mptAssetScale(session)).toString();
  return v;
}

// The term length (LoanSet.PaymentTotal) is a plain count of scheduled payments — NOT an asset amount,
// so it never runs through brokerValue/xrpToDrops. Omitted means the ledger derives the schedule; when
// supplied it must be a positive integer, or Number("") → NaN would submit a malformed transaction the
// ledger rejects opaquely. Turn a bad count into a clean 400 here.
function paymentTotal(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ActionError(`invalid term: ${value}`, 400);
  return n;
}

// The credential type for a credential/domain action: the request's explicit value, or the session's
// configured type. Credential actions only make sense on a permissioned vault, so a public vault (no
// domain) rejects them outright — a client cannot re-enable them by supplying an explicit type.
function resolveCredentialType(session: Session, p: Record<string, string>): string {
  if (session.env.objects.domainId === undefined) {
    throw new ActionError("this session is a public vault and has no credential scheme", 409);
  }
  const type = p.credentialType ?? session.env.credentialType;
  if (!type) throw new ActionError("this session has no credential type configured", 409);
  return type;
}

// The credential issuer's address — the account that grants the session's domain credentials, distinct
// from the currency issuer. A public vault has none, so a credential action that needs it is rejected.
function resolveCredentialIssuer(session: Session): string {
  const address = session.env.accounts.credentialIssuer?.address;
  if (!address) throw new ActionError("this session is a public vault and has no credential issuer", 409);
  return address;
}

function encodeCredentialType(type: string): string {
  return Buffer.from(type, "utf8").toString("hex").toUpperCase();
}

function required(params: Record<string, string>, key: string): string {
  const v = params[key];
  if (v === undefined || v === "") throw new ActionError(`missing parameter ${key}`);
  return v;
}
