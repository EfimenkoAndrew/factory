#!/usr/bin/env bash
# KI-E417: Nightly factory dispatch — runs daily via system cron to restore automated velocity.
#
# INSTALLATION (one-time, run as root):
#   crontab -e
#   Add:  47 2 * * * /path/to/your-repo/_bmad-output/ai-factory/orchestrator/nightly-dispatch.sh >> /root/.claude/factory-nightly.log 2>&1
#
# What it does:
#   1. Adds /root/.local/bin to PATH so claude CLI is found (it lives there on this host)
#   2. Checks the 75% weekly token quota gate — skips if near limit
#   3. Runs the factory with claude-headless backend (autonomous, no controlling session needed)
#   4. Logs start/end with timestamps to the log file (see INSTALLATION path above)
#
# Quota gate: reads cost-history.jsonl to estimate weekly token usage. If >= 75% of the
# 51.6M weekly limit (38.7M tokens), skips this run and exits 0 (non-error).
#
# Backend: uses claude-headless — spawns claude CLI in print mode. IS_SANDBOX=1 is set
# automatically by orchestrate.mjs for root execution (KI-E293).
#
# See KI-E416 for the companion phantom-CLAIMED-item fix that runs at startup.

set -euo pipefail

FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$FACTORY_ROOT/../.." && pwd)"
LOG_PREFIX="[nightly-dispatch $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

echo "$LOG_PREFIX start — FACTORY_ROOT=$FACTORY_ROOT"

# 1. Extend PATH so claude CLI is found (installed at /root/.local/bin on this host)
export PATH="/root/.local/bin:$PATH"

# Verify claude is available
if ! command -v claude &>/dev/null; then
  echo "$LOG_PREFIX ERROR: claude binary not found on PATH after extension. Aborting."
  echo "$LOG_PREFIX PATH=$PATH"
  exit 1
fi
echo "$LOG_PREFIX claude found: $(which claude) ($(claude --version 2>&1 | head -1))"

# 2. Weekly quota gate: skip if >= 75% of 51.6M limit (38.7M tokens)
WEEKLY_LIMIT=51600000
QUOTA_THRESHOLD=$(echo "$WEEKLY_LIMIT * 75 / 100" | bc)  # 38,700,000

COST_FILE="$FACTORY_ROOT/reports/cost-history.jsonl"
WEEK_TOKENS=0
if [[ -f "$COST_FILE" ]]; then
  # ISO week start (Monday 00:00:00 UTC)
  WEEK_START=$(node -e "
    const d = new Date();
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1 - day);
    d.setUTCDate(d.getUTCDate() + diff);
    d.setUTCHours(0,0,0,0);
    process.stdout.write(d.toISOString());
  ")
  WEEK_TOKENS=$(node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('$COST_FILE', 'utf8').trim().split('\n').filter(Boolean);
    const weekStart = '$WEEK_START';
    let total = 0;
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if ((r.ts || '') >= weekStart) total += (r.tokensUsed || 0);
      } catch {}
    }
    process.stdout.write(String(total));
  " 2>/dev/null || echo 0)
fi

echo "$LOG_PREFIX week tokens used: $WEEK_TOKENS / $WEEKLY_LIMIT (threshold: $QUOTA_THRESHOLD)"
if [[ "$WEEK_TOKENS" -ge "$QUOTA_THRESHOLD" ]]; then
  echo "$LOG_PREFIX QUOTA GATE: $WEEK_TOKENS >= $QUOTA_THRESHOLD (75% of $WEEKLY_LIMIT) — skipping dispatch"
  exit 0
fi

# 3. Check stop marker
STOP_MARKER="$FACTORY_ROOT/state/STOP_REQUESTED.md"
if [[ -f "$STOP_MARKER" ]]; then
  echo "$LOG_PREFIX STOP_REQUESTED.md present — skipping dispatch (human decision; delete to resume)"
  exit 0
fi

# 4. Run the factory
echo "$LOG_PREFIX launching factory (claude-headless backend, 1 lane)..."
cd "$REPO_ROOT"
node "$FACTORY_ROOT/orchestrator/orchestrate.mjs" run --backend claude-headless --max-lanes 1
STATUS=$?

echo "$LOG_PREFIX done — exit status: $STATUS"
exit $STATUS
