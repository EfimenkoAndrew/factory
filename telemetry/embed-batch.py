#!/usr/bin/env python3
"""
embed-batch.py — batch text embedder for factory_telemetry (KI-E385).

Usage (from orchestrate.mjs via docker exec):
  echo '["text one", "text two"]' | docker exec -i factory-vectorizer python3 /embed.py

Reads a JSON array of strings from stdin.
Writes a JSON array of 384-dim float arrays to stdout.
Uses the pre-cached BAAI/bge-small-en-v1.5 model (already in the vectorizer image).

Errors: any exception → empty array [] on stdout + message on stderr.
"""
import sys, json

def main():
    try:
        texts = json.load(sys.stdin)
        if not isinstance(texts, list) or not texts:
            print("[]")
            return
        # Truncate each text to 512 chars to keep inference fast
        texts = [str(t)[:512] for t in texts]
        from fastembed import TextEmbedding
        model = TextEmbedding("BAAI/bge-small-en-v1.5",
                              cache_dir="/root/.cache/fastembed")
        vecs = list(model.embed(texts))
        print(json.dumps([v.tolist() for v in vecs]))
    except Exception as e:
        print("[]")
        print(f"embed-batch error: {e}", file=sys.stderr)

if __name__ == "__main__":
    main()
