# Monitoring

A self-contained monitoring stack over the lending history store. It surfaces the state the store
already projects — transactions captured, vault assets and shares, broker cover and debt, loans by
status, and the outbox backlog — as Prometheus metrics rendered in Grafana, so a third party can
observe a running deployment without reading the database directly.

## Components

- **postgres_exporter** — runs the SQL in `queries.yaml` against the history store and exposes the
  results as metrics. Each metric carries the run's setup id as a label.
- **Prometheus** — scrapes the exporter (`prometheus.yml`).
- **Grafana** — provisioned with a Prometheus datasource and a dashboard (`grafana/`) that filters by
  run.

## Running it

Point `DATABASE_URL` at the history-store Postgres and start the stack:

```sh
DATABASE_URL=postgresql://user:pass@host:5432/db docker compose up
```

- Grafana: `http://localhost:3000` (anonymous viewer access enabled) — open the
  "Permissioned Lending — History Store" dashboard and pick a run.
- Prometheus: `http://localhost:9090`.

## Metrics

| Metric | Meaning |
|---|---|
| `lending_transactions_total` | Transactions captured, per run |
| `lending_events_by_type_total` | Normalized events, per run and type |
| `lending_vault_assets_total` / `_available` | Vault total and available assets, per run |
| `lending_vault_shares_outstanding` | Vault shares outstanding, per run |
| `lending_broker_cover_cover_available` / `_debt_total` | Broker first-loss cover and outstanding debt |
| `lending_loans_by_status_total` | Loans by status (active, repaid, closed, defaulted) |
| `lending_outbox_pending` | Outbox markers not yet confirmed (should trend to zero) |
