# AI Factory — telemetry & observability stack

Event-sourced observability per the `ai-factory-observability` spine
(`_bmad-output/planning-artifacts/architecture/architecture-ai-factory-observability-2026-07-17/`).
The append-only stream `data/events.jsonl` is the source of truth (AD-1); everything here is a
**derived view** — the factory runs fine with this whole stack down.

## Quickstart

```bash
cd _bmad-output/ai-factory/telemetry
docker compose up -d --build
```

| Service | URL | What |
|---|---|---|
| Grafana | http://localhost:3000 | "AI Factory" dashboard (anonymous viewer; provisioned from `grafana/dashboards/ai-factory.json`) |
| Prometheus | http://localhost:9090 | scrapes the exporter (`factory_*`) + collector spanmetrics (`traces_span_metrics_*`) |
| Exporter | http://localhost:9464/metrics | zero-dep Node tail of `data/events.jsonl` |
| OTel collector | :4317 gRPC / :4318 HTTP | receives item/stage spans from the exporter; spanmetrics → :8889 |

Port clashes: `cp .env.example .env` and edit.

## Permanence (AD-6)

- `prometheus-data` / `grafana-data` are **named volumes** — they survive `docker compose down`
  (only `down -v` destroys them). Prometheus retention: 180d.
- The event stream lives on the **host** (`./data/events.jsonl`, bind-mounted read-only) and is
  git-ignored (generated data). Rotating it is an operator action taken only while the factory is
  idle; the exporter detects truncation/inode change and full-replays (AD-13).

## How events flow

```
driver.mjs / agents (telemetry-emit.mjs) / fold mtime-backfill
        └─append──> data/events.jsonl ──tail── exporter ──/metrics──> Prometheus ──> Grafana
                                                └──OTLP/HTTP spans──> otel-collector ──spanmetrics :8889──> Prometheus
```

- **`source:'derived'` is the only duration authority** (AD-12); agent events feed the separate
  `factory_agent_*` family (liveness/compliance only).
- Traces: one trace per item attempt (`traceId = sha256(item#cycle)`), stage spans as children —
  deterministic across exporter restarts (AD-13).
- Evaluation reads the JSONL directly: `node _bmad-output/ai-factory/_workflow/driver.mjs telemetry-report`
  → `reports/telemetry-latest.md` (AD-9 — never Prometheus aggregates).

## Kill-switch

`FACTORY_TELEMETRY=0` disables all emission; `FACTORY_TELEMETRY_DIR` relocates the stream.
Emission never throws and never blocks factory work (KI-E7).
