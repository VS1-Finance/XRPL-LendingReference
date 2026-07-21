import { signLoanSetByCounterparty, xrpToDrops } from "xrpl";
import type { Amount, SubmittableTransaction } from "xrpl";
import { clampIssuedValueUp, deriveAccount } from "@lending/shared";
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

// tfLoanDefault on LoanManage — the flag the owner sets to default a delinquent loan. This is the
// same transaction the broker-enforcer bot submits; exposing it as an owner action lets a human do by
// hand what the bot does automatically.
const TF_LOAN_DEFAULT = 65536;

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

  const tx = await buildTransaction(session, seat.address, request);
  const result = await seat.signer.submit(tx);
  return { action: request.action, code: result.engineResult, ...(result.hash ? { hash: result.hash } : {}) };
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
  const borrowerSeat = session.seats.get(required(params, "borrower"));
  if (!borrowerSeat) throw new ActionError(`session has no seat ${params.borrower}`, 404);

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
    LoanOriginationFee: "0",
  };

  // Origination needs two raw signatures on one transaction, which the single-signer submit path does
  // not express, so the owner and borrower wallets are re-derived from the session seed for the
  // bilateral sign. The derived addresses match the seats, which is what binds the signatures to the
  // seats' identities.
  const ownerWallet = deriveAccount(session.seed, "owner", owner.index).wallet;
  const borrowerWallet = deriveAccount(session.seed, "borrower", borrowerSeat.index).wallet;
  const prepared = await session.client.autofill(loanSet);
  const ownerSigned = ownerWallet.sign(prepared);
  const combined = signLoanSetByCounterparty(borrowerWallet, ownerSigned.tx_blob);
  const res = await session.client.submitAndWait(combined.tx_blob);
  const meta = res.result.meta;
  const code = typeof meta === "object" && meta && "TransactionResult" in meta ? meta.TransactionResult : "unknown";
  return { action: "originate", code, hash: res.result.hash };
}

// Whether the vault asset is native XRP (currency "XRP" with no issuer) rather than an issued token.
function isXrp(session: Session): boolean {
  const { currency, issuer } = session.env.asset;
  return currency === "XRP" && !issuer;
}

// Builds a ledger Amount for the session's asset from a whole-token value. For XRP that is a bare drops
// string; for an issued token it is a currency/issuer/value object. Every action that carries an amount
// goes through this, so both asset kinds are handled in one place.
function assetAmount(session: Session, value: string): Amount {
  if (isXrp(session)) return xrpToDrops(value);
  const { currency, issuer } = session.env.asset;
  if (!issuer) throw new ActionError("issued asset has no issuer", 500);
  return { currency, issuer, value };
}

// A bare numeric value in the broker's asset units, for fields (loan principal, debt max) that take a
// plain number rather than a full Amount: drops for XRP, whole tokens otherwise.
function brokerValue(session: Session, value: string): string {
  return isXrp(session) ? xrpToDrops(value) : value;
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
