# @lending/lifecycle

Runs one complete loan lifecycle against an environment provisioned by the bootstrap harness,
observable end to end on Devnet.

A run steps through:

1. **deposit** — the depositor supplies liquidity to the vault and receives shares (asserted minted)
2. **origination** — a loan is opened with a **bilateral** `LoanSet`: the owner signs and the
   borrower counter-signs the same transaction. Principal is delivered to the borrower inside the
   `LoanSet`, which is asserted by the borrower's balance growing — there is no separate draw step.
3. **repayment** — the borrower pays the scheduled installment each interval until the loan is
   fully settled
4. **close** — the repaid loan is removed; full settlement may remove it automatically, otherwise
   the owner issues `LoanDelete`

Every transaction carries the run's setup id and a per-action correlation id. The vault's total
assets are read before and after, so the depositor's earned yield is visible on-chain rather than
computed off a float. The ordered, tx-hash-backed step record is written to
`out/<setup-id>.lifecycle.json`.

## Usage

```sh
pnpm lifecycle run --provisioned ./out/<setup-id>.json --seed <seed>

# shorter intervals and a smaller loan
pnpm lifecycle run --provisioned ./out/<setup-id>.json --seed <seed> --interval 60 --principal 5000
```

The seed must be the one the environment was provisioned with: account wallets are re-derived from
it and checked against the provisioned addresses before the run starts.

## Terminal branches

Repayment-and-close is the built-in terminal branch. The runner exposes a branch seam so an
alternative terminal behaviour can reuse deposit and origination unchanged by supplying its own
driver for the originated loan.
