FROM python:3.12-slim

WORKDIR /app

# fastembed: lightweight ONNX embedding runner (no PyTorch / GPU).
# qdrant-client: official Python SDK.
# Pinned to minor version ranges; no patch-exact pin here because this is a
# developer tool Docker image, not a k8s service manifest subject to
# deploy-verification.md image-tag rules.
RUN pip install --no-cache-dir \
    "fastembed>=0.2.7,<0.5" \
    "qdrant-client>=1.9.0,<2"

# Pre-cache the ONNX model at build time so the first container start is instant.
# The model (~23 MB) is stored in the layer; no network needed at runtime.
ENV FASTEMBED_CACHE_PATH=/root/.cache/fastembed
RUN python -c "\
from fastembed import TextEmbedding; \
list(TextEmbedding('BAAI/bge-small-en-v1.5', \
    cache_dir='/root/.cache/fastembed').embed(['warmup']))"

COPY ingest.py .

CMD ["python", "-u", "ingest.py"]
