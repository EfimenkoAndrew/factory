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

### A second host repo on the same machine (KI-E25)

The factory is mountable in any number of host repos, but the telemetry stack is per-host.
Ports are not the whole story: `container_name` is fixed in the compose file and **`docker
compose -p` cannot override it**, while the compose project name scopes the `prometheus-data`
/ `grafana-data` volumes. So host B must set the stack's *identity* as well as its ports —
otherwise it fails outright on duplicate container names, and (once renamed) would silently
share host A's volumes:

```bash
cp .env.example .env      # then, in host B's .env:
FACTORY_COMPOSE_PROJECT=<hostB>-factory-telemetry
FACTORY_CONTAINER_PREFIX=<hostB>-factory
FACTORY_GRAFANA_PORT=3100     # ...and every other port
```

Defaults reproduce the historical single-host names exactly, so an existing stack is unaffected.

## Claude Code cost telemetry (the two token/cache panels) — KI-E28

The dashboard ships two cost panels — **Claude Code token rate by type** and **Prompt-cache hit
ratio** — that read `claude_code_token_usage_tokens_total`. That series is emitted by the **Claude
Code session itself**, not by the factory exporter, so it appears only once you point your session's
OpenTelemetry at this collector. The collector is already wired to accept it (`otel-collector.yaml`
routes the OTLP `metrics` pipeline to Prometheus; the OTLP HTTP port is exposed) — the only missing
piece is the session-side env. Until you set it, those two panels are **empty, not broken**; every
`factory_*` panel populates without it.

```bash
# in the shell that launches the factory's Claude Code session:
set -a; . telemetry/claude-code-telemetry.env; set +a   # from claude-code-telemetry.env.example
```

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at this host's collector HTTP port — `http://localhost:4318`
for the default stack, or `http://localhost:<FACTORY_OTLP_HTTP_PORT>` (e.g. `4418`) for a KI-E25
second stack. See `claude-code-telemetry.env.example` for the full set.

> The **Span-derived stage latency p90** panel is live-only: the exporter pushes spans to the
> collector only for events that arrive **while it is running** (historical events replay as
> `factory_*` metrics but are not re-pushed as spans — AD-13). The **Stage duration p95** panel is
> the duration authority and always populates from the exporter's own histogram, stack-up or not.

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
