# XRPL Permissioned Lending — Reference Implementation

A reference implementation of permissioned, credential-gated lending on the XRP Ledger, built on
four amendments that work together:

- **XLS-65 — Single Asset Vault.** A vault that holds one asset and issues fungible shares against
  deposits.
- **XLS-66 — Lending Protocol.** A loan broker on a vault that originates loans, holds first-loss
  cover, and tracks repayment and default.
- **XLS-70 — Credentials.** On-ledger credentials issued to accounts and accepted by them.
- **XLS-80 — Permissioned Domains.** A domain that admits only accounts holding accepted
  credentials, gating who may interact with a vault.

Together these let a vault accept deposits only from credentialed members of a permissioned domain,
originate loans against that liquidity through a broker, and let the asset issuer retain clawback
and freeze control over funds.

Provisioning also uses **XLS-56 — Batch** where cross-account setup steps belong together atomically:
a member's `CredentialCreate` + `CredentialAccept`, and a holder's `TrustSet` + issuer distribution,
are each submitted as one all-or-nothing `Batch` transaction rather than as separate transactions.
This is an infrastructure detail — the four amendments above are the product; Batch is how the
environment is stood up. Batch requires the `BatchV1_1` amendment (active on Devnet) and a matching
`xrpl` client (see Networks).

## Repository layout

This is a pnpm workspace monorepo.

```
packages/
  shared/      cross-cutting utilities consumed across the codebase:
               config loading + validation, deterministic account derivation,
               treasury funding, setup-id / correlation-id transaction tagging,
               integer money, and the ledger client wrapper
  bootstrap/   the environment bootstrap harness — see packages/bootstrap/README.md
```

## Requirements

- Node ≥ 22
- pnpm 10

## Install

```sh
pnpm install
```

## Bootstrap a wired environment

A single command stands up a fully wired environment from a config file: funded accounts, issued
and accepted credentials, a permissioned domain, a domain-gated single-asset vault, and a loan
broker on that vault with first-loss cover deposited. Every transaction is stamped with a **setup
id** (identifying the whole environment) and a **correlation id** (identifying the action), and the
resulting object graph is written to `out/<setup-id>.json`.

```sh
# provision from config
pnpm bootstrap --config ./packages/bootstrap/config.example.json

# validate the config and derive accounts without touching the network
pnpm bootstrap --config ./packages/bootstrap/config.example.json --dry-run

# tear an environment down by setup id
pnpm bootstrap teardown --setup-id <id> --config ./packages/bootstrap/config.example.json
```

The harness is **idempotent**: account derivation is a pure function of the configured seed, so a
re-run reuses the same accounts, and each provisioning step checks the ledger before acting and
skips work that already exists. Re-running against a partially provisioned environment completes it
without creating duplicate objects.

It also checks two invariants at run time and aborts if either fails: the broker and the vault must
report the same owner account, and the seeded cover must clear the configured amount.

See [`packages/bootstrap/README.md`](packages/bootstrap/README.md) for the full CLI, config
reference, and the order of operations.

## Networks

The harness targets XRPL **Devnet** by default, where the vault and lending amendments are active.
`wasm-devnet` is supported as an alternative endpoint. Accounts are funded from the network faucet;
no real funds are involved.

## Configuration

Configuration is a single JSON file, validated before any network work begins — an invalid config
fails fast with a readable list of every problem. A worked example lives at
[`packages/bootstrap/config.example.json`](packages/bootstrap/config.example.json).

The default vault asset is an issued currency (an IOU with an issuer), because the issuer powers
the reference implementation exercises — clawback and freeze — only exist on an issued asset and
cannot be applied to native XRP.

## Typecheck

```sh
pnpm typecheck
```

## License

Proprietary. All rights reserved.
