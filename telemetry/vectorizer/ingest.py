#!/usr/bin/env python3
"""
Factory telemetry vectorizer.

Ingests all factory events/*.jsonl files into Qdrant so the full run history
is searchable by vector similarity AND by structured payload filters.

  Startup : backfill all three monthly files (Aug, Sep, Oct) in order,
            then tail the current file for new events every POLL_INTERVAL sec.
  Cursor  : byte-level line cursors persisted to /data/cursor/position.json
            so restarts resume without re-indexing.
  Model   : BAAI/bge-small-en-v1.5  (384-dim, 23 MB ONNX — pre-cached in image).
  IDs     : deterministic uint64 from MD5(file+lineno+ts+event+item) — safe to upsert.
"""
import hashlib
import json
import logging
import os
import pathlib
import struct
import time

from fastembed import TextEmbedding
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    PayloadSchemaType,
    PointStruct,
    TextIndexParams,
    TokenizerType,
    VectorParams,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("vectorizer")

QDRANT_HOST = os.environ.get("QDRANT_HOST", "qdrant")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", "6333"))
COLLECTION = "factory_telemetry"
MODEL_NAME = "BAAI/bge-small-en-v1.5"
BATCH_SIZE = 128
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))
CURSOR_FILE = pathlib.Path("/data/cursor/position.json")

DATA_DIR = pathlib.Path(os.environ.get("EVENTS_DIR", "/data/events"))
EVENT_FILES = [
    DATA_DIR / "events-2026-08.jsonl",
    DATA_DIR / "events-2026-09.jsonl",
    DATA_DIR / "events.jsonl",   # current month — tailed live
]
LIVE_FILE = EVENT_FILES[-1]


# ── text representation ───────────────────────────────────────────────────────

def event_to_text(e: dict) -> str:
    """Synthesise a searchable text string for embedding."""
    parts = [
        e.get("event", ""),
        e.get("item", ""),
        e.get("source", ""),
        e.get("stage", ""),
        e.get("role", ""),
    ]
    if e.get("outcome"):
        parts.append(f"outcome:{e['outcome']}")
    if e.get("cycle") is not None:
        parts.append(f"cycle:{e['cycle']}")

    attrs = e.get("attrs") or {}
    ev = e.get("event", "")

    if ev == "item_folded":
        if attrs.get("toState"):
            parts.append(f"state:{attrs['toState']}")
        if attrs.get("note"):
            parts.append(attrs["note"])
        transitions = attrs.get("transitions") or []
        if transitions:
            parts.append("transitions:" + "→".join(transitions))
        gates = attrs.get("gates") or {}
        failed = [f"{k}={v}" for k, v in gates.items() if v != "APPROVED"]
        if failed:
            parts.append("failed:" + " ".join(failed))

    elif ev == "attempt_observation":
        obs = attrs.get("observation") or {}
        for key in ("phase", "band", "outcome"):
            if obs.get(key):
                parts.append(f"{key}:{obs[key]}")
        if obs.get("attemptNumber") is not None:
            parts.append(f"attempt:{obs['attemptNumber']}")
        if obs.get("lateDeterministicFailure"):
            parts.append("late_deterministic_failure")
        if obs.get("recovery"):
            parts.append("recovery")

    elif ev == "driver_cmd":
        if attrs.get("cmd"):
            parts.append(f"cmd:{attrs['cmd']}")

    elif ev == "fold_summary":
        for k in ("applied", "rejected", "skipped", "escalated"):
            if attrs.get(k):
                parts.append(f"{k}:{attrs[k]}")

    elif ev == "transition":
        pass  # outcome + cycle already captured above

    elif ev == "stage_end":
        pass  # stage + outcome already captured

    return " ".join(p for p in parts if p)


def flatten_payload(e: dict) -> dict:
    """Flatten event into a Qdrant payload dict; drop None / empty values."""
    attrs = e.get("attrs") or {}
    obs = (attrs.get("observation") or {}) if e.get("event") == "attempt_observation" else {}

    payload: dict = {
        "event":   e.get("event", ""),
        "item":    e.get("item", ""),
        "source":  e.get("source", ""),
        "stage":   e.get("stage", ""),
        "role":    e.get("role", ""),
        "outcome": e.get("outcome", ""),
        "run_id":  e.get("runId", ""),
        "text":    event_to_text(e),
        "raw":     json.dumps(e),
    }

    if e.get("ts"):
        payload["ts"] = e["ts"]
    if e.get("cycle") is not None:
        payload["cycle"] = int(e["cycle"])

    if e.get("event") == "item_folded":
        payload["to_state"] = attrs.get("toState", "")
        if attrs.get("note"):
            payload["note"] = attrs["note"]
        if attrs.get("tokensUsed") is not None:
            payload["tokens_used"] = int(attrs["tokensUsed"])
        if attrs.get("transitions"):
            payload["transitions"] = attrs["transitions"]
        gates = attrs.get("gates") or {}
        failed = [k for k, v in gates.items() if v != "APPROVED"]
        if failed:
            payload["failed_gates"] = failed
        cost = attrs.get("cost") or {}
        if cost:
            payload["cost_models"] = list(cost.keys())

    elif e.get("event") == "attempt_observation":
        for key in ("phase", "band"):
            if obs.get(key):
                payload[key] = obs[key]
        if obs.get("outcome"):
            payload["obs_outcome"] = obs["outcome"]
        if obs.get("attemptNumber") is not None:
            payload["attempt_number"] = int(obs["attemptNumber"])
        if obs.get("recovery"):
            payload["recovery"] = True
        if obs.get("band"):
            payload["band"] = obs["band"]

    return {k: v for k, v in payload.items() if v not in (None, "", [])}


def stable_id(filepath: str, line_num: int, e: dict) -> int:
    """Deterministic uint64 — safe for Qdrant point IDs."""
    raw = f"{filepath}:{line_num}:{e.get('ts','')}:{e.get('event','')}:{e.get('item','')}"
    digest = hashlib.md5(raw.encode()).digest()
    return struct.unpack("<Q", digest[:8])[0] & 0x7FFFFFFFFFFFFFFF


# ── Qdrant setup ─────────────────────────────────────────────────────────────

def setup_collection(client: QdrantClient) -> None:
    existing = {c.name for c in client.get_collections().collections}
    if COLLECTION in existing:
        log.info("Collection '%s' exists (%d points)", COLLECTION, client.count(COLLECTION).count)
        return

    log.info("Creating collection '%s'…", COLLECTION)
    client.create_collection(
        collection_name=COLLECTION,
        vectors_config=VectorParams(size=384, distance=Distance.COSINE),
    )

    keyword_fields = [
        "event", "item", "source", "stage", "role", "outcome",
        "to_state", "phase", "band", "obs_outcome",
        "failed_gates", "transitions", "cost_models",
    ]
    for field in keyword_fields:
        try:
            client.create_payload_index(COLLECTION, field, field_schema=PayloadSchemaType.KEYWORD)
        except Exception as ex:
            log.warning("Keyword index %s: %s", field, ex)

    for field in ("cycle", "attempt_number", "tokens_used"):
        try:
            client.create_payload_index(COLLECTION, field, field_schema=PayloadSchemaType.INTEGER)
        except Exception as ex:
            log.warning("Integer index %s: %s", field, ex)

    try:
        client.create_payload_index(COLLECTION, "ts", field_schema=PayloadSchemaType.DATETIME)
    except Exception as ex:
        log.warning("Datetime index ts: %s", ex)

    try:
        client.create_payload_index(
            COLLECTION, "text",
            field_schema=TextIndexParams(type="text", tokenizer=TokenizerType.WORD, min_token_len=2),
        )
    except Exception as ex:
        log.warning("Text index: %s", ex)

    log.info("Collection and %d payload indexes created.", len(keyword_fields) + 4)


# ── ingestion ─────────────────────────────────────────────────────────────────

def load_cursor() -> dict:
    try:
        return json.loads(CURSOR_FILE.read_text())
    except Exception:
        return {}


def save_cursor(cursor: dict) -> None:
    CURSOR_FILE.parent.mkdir(parents=True, exist_ok=True)
    CURSOR_FILE.write_text(json.dumps(cursor))


def _flush(client: QdrantClient, model: TextEmbedding,
           texts: list, payloads: list, ids: list) -> None:
    vectors = list(model.embed(texts))
    points = [
        PointStruct(id=ids[i], vector=vectors[i].tolist(), payload=payloads[i])
        for i in range(len(texts))
    ]
    client.upsert(collection_name=COLLECTION, points=points)


def ingest_file(
    client: QdrantClient,
    model: TextEmbedding,
    filepath: pathlib.Path,
    cursor: dict,
    is_live: bool = False,
) -> dict:
    key = str(filepath)
    if not filepath.exists():
        return cursor

    start_line = cursor.get(key, 0)
    batch_t, batch_p, batch_i = [], [], []
    total = 0
    last_line = start_line

    with filepath.open() as fh:
        for line_num, raw in enumerate(fh):
            if line_num < start_line:
                continue
            raw = raw.strip()
            last_line = line_num + 1
            if not raw:
                continue
            try:
                e = json.loads(raw)
            except json.JSONDecodeError:
                continue

            batch_t.append(event_to_text(e))
            batch_p.append(flatten_payload(e))
            batch_i.append(stable_id(key, line_num, e))

            if len(batch_t) >= BATCH_SIZE:
                _flush(client, model, batch_t, batch_p, batch_i)
                total += len(batch_t)
                batch_t, batch_p, batch_i = [], [], []
                cursor[key] = last_line
                if not is_live and total % 4096 == 0:
                    save_cursor(cursor)
                    log.info("  %s: %d events…", filepath.name, total)

    if batch_t:
        _flush(client, model, batch_t, batch_p, batch_i)
        total += len(batch_t)

    if last_line > start_line:
        cursor[key] = last_line

    if total:
        log.info("Ingested %d events from %s (cursor → line %d)", total, filepath.name, last_line)
    return cursor


# ── entrypoint ────────────────────────────────────────────────────────────────

def wait_for_qdrant() -> QdrantClient:
    for attempt in range(30):
        try:
            c = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=10, check_compatibility=False)
            c.get_collections()
            log.info("Qdrant ready at %s:%d", QDRANT_HOST, QDRANT_PORT)
            return c
        except Exception as ex:
            log.info("Waiting for Qdrant (%d/30): %s", attempt + 1, ex)
            time.sleep(5)
    raise SystemExit("Qdrant unreachable after 30 attempts")


def main() -> None:
    client = wait_for_qdrant()

    log.info("Loading model: %s", MODEL_NAME)
    cache = os.environ.get("FASTEMBED_CACHE_PATH", "/root/.cache/fastembed")
    model = TextEmbedding(MODEL_NAME, cache_dir=cache)
    log.info("Model ready.")

    setup_collection(client)
    cursor = load_cursor()

    log.info("=== Backfill ===")
    for f in EVENT_FILES:
        cursor = ingest_file(client, model, f, cursor)
        save_cursor(cursor)
    log.info("=== Backfill complete: %d total points ===", client.count(COLLECTION).count)

    log.info("=== Tailing %s every %ds ===", LIVE_FILE.name, POLL_INTERVAL)
    while True:
        time.sleep(POLL_INTERVAL)
        cursor = ingest_file(client, model, LIVE_FILE, cursor, is_live=True)
        save_cursor(cursor)


if __name__ == "__main__":
    main()
