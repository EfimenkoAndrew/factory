# AI Factory — telemetry & observability stack

Event-sourced observability. The append-only stream `data/events.jsonl` is the source of
truth; everything here is a **derived view** — the factory runs fine with this whole
stack down.

## Quickstart

```bash
cd <mount>/telemetry        # e.g. _bmad-output/ai-factory/telemetry
docker compose up -d --build
```

| Service | URL | What |
|---|---|---|
| Grafana | http://localhost:3000 | "AI Factory" dashboard (anonymous viewer; provisioned from `grafana/dashboards/ai-factory.json`) |
| Prometheus | http://localhost:9090 | scrapes the exporter (`factory_*`) + collector spanmetrics (`traces_span_metrics_*`) |
| Exporter | http://localhost:9464/metrics | zero-dep Node tail of `data/events.jsonl` |
| OTel collector | :4317 gRPC / :4318 HTTP | receives item/stage spans from the exporter; spanmetrics → :8889 |

Port clashes: `cp .env.example .env` and edit.

## Permanence

- `prometheus-data` / `grafana-data` are **named volumes** — they survive `docker compose down`
  (only `down -v` destroys them). Prometheus retention: 180d.
- The event stream lives on the **host** (`./data/events.jsonl`, bind-mounted read-only) and is
  git-ignored (generated data). Rotating it is an operator action taken only while the factory is
  idle; the exporter detects truncation/inode change and full-replays.

## How events flow

```
driver.mjs / agents (telemetry-emit.mjs) / fold mtime-backfill
        └─append──> data/events.jsonl ──tail── exporter ──/metrics──> Prometheus ──> Grafana
                                                └──OTLP/HTTP spans──> otel-collector ──spanmetrics :8889──> Prometheus
```

- **`source:'derived'` is the only duration authority**; agent events feed the separate
  `factory_agent_*` family (liveness/compliance only).
- Traces: one trace per item attempt (`traceId = sha256(item#cycle)`), stage spans as children —
  deterministic across exporter restarts.
- Evaluation reads the JSONL directly: `node <mount>/_workflow/driver.mjs telemetry-report`
  → `reports/telemetry-latest.md` (never Prometheus aggregates).

## Kill-switch

`FACTORY_TELEMETRY=0` disables all emission; `FACTORY_TELEMETRY_DIR` relocates the stream.
Emission never throws and never blocks factory work (KI-E7).
