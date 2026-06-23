# @lending/bootstrap

Stands up a fully wired permissioned lending environment from a single config file, idempotently,
and tears it down when asked.

A run produces, in order:

1. funded accounts — a faucet-funded treasury fans XRP out to deterministically derived accounts
2. issuer configuration — clawback and default-ripple enabled before any asset is issued
3. trust lines + asset distribution to the owner and every pool member
4. issued and accepted credentials for each pool member
5. a permissioned domain accepting those credentials
6. a domain-gated, private single-asset vault owned by the owner account
7. a loan broker on that vault, owned by the same account
8. first-loss cover seeded into the broker

Every transaction is tagged with the run's **setup id** and a per-action **correlation id**. The
resulting object graph is written to `out/<setup-id>.json`.

## Usage

```sh
# provision from config
pnpm --filter @lending/bootstrap start --config ./config.example.json

# validate config and derive accounts without touching the network
pnpm --filter @lending/bootstrap start --config ./config.example.json --dry-run

# tear an environment down (objects + stored graph)
pnpm --filter @lending/bootstrap start teardown --setup-id <id> --config ./config.example.json
```

## Idempotency

Account derivation is a pure function of `(seed, role, index)`, so a re-run reuses the same
addresses. Each provisioning step checks the ledger before acting and skips work that already
exists, so re-running against a partially provisioned environment completes it without
duplicating objects.

## Invariants checked at run time

- the broker and the vault report the same owner account
- seeded cover clears the configured cover amount

A run aborts with an error if either check fails.

## Config

See `config.example.json`. Fields are validated before any network work begins; an invalid config
fails fast with a readable list of problems.
