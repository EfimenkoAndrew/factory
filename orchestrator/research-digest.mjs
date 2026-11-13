// KI-E359 — Research-informed self-improvement proposals.
// Encodes actionable patterns from recent AI self-improvement research and maps them onto
// the factory's observable failure modes. Unlike self-improve.mjs (which is purely empirical),
// this module is THEORY-DRIVEN: it asks "what does the literature say a system like ours should
// try when it plateaus?" and queues the answer as a normal gated work item.
//
// Sources distilled here (no live web access needed — findings encoded as heuristics):
//   Reflexion (Shinn et al. 2023)    — verbal reinforcement from failure traces
//   Self-Refine (Madaan et al. 2023) — iterative self-critique + revision loops
//   Constitutional AI (Anthropic 2022) — critique-revise pass against a rule set
//   Tree of Thought (Yao et al. 2023) — multi-path exploration, best-of-N selection
//   STaR (Zelikman et al. 2022)      — self-taught reasoning via rationale bootstrapping
//   RLHF/RLAIF signal mining         — treat gate verdicts as reward signal for prompt tuning
//   Population-Based Training (PBT)  — exploit top performers + mutate; mirrors prompt-evolution
//   LLM-based code repair research   — break repair into atomic, verifiable steps (SWE-bench)
//   Self-Consistency (Wang et al. 2023) — majority-vote over multiple reasoning chains
//   Calibration via RLHF (Kadavath et al. 2022) — model knows what it knows; confidence gating
//
// Zero deps. Called by the periodic-self-improve cron (KI-E360) and by driver `research-digest`.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// KI-E366: read telemetry/data/events.jsonl for gate rejection counts and stage duration averages.
// Returns { gateRejections, stageDurations, stageDurationsP95, source: 'telemetry' } or null.
function readTelemetrySnapshot(root) {
  try {
    const telPath = join(root, 'telemetry', 'data', 'events.jsonl');
    if (!existsSync(telPath)) return null;
    const stageDurMs = {};
    const gateRejections = {};
    for (const line of readFileSync(telPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.source === 'derived' && e.event === 'stage_end' && e.stage && e.durMs) {
        (stageDurMs[e.stage] = stageDurMs[e.stage] || []).push(e.durMs);
      }
      if (e.source === 'agent' && e.event === 'stage_end' && typeof e.role === 'string' && e.role.startsWith('gate-')) {
        const verdict = e.attrs?.verdict || '';
        if (/CHANGES_REQUIRED|REJECT|\bFAIL|BLOCK|NOT[ _]?OK|DENIED|\bERROR/i.test(verdict)) {
          const gate = e.role.replace('-', ':');
          gateRejections[gate] = (gateRejections[gate] || 0) + 1;
        }
      }
    }
    const stageDurations = {};
    const stageDurationsP95 = {};
    for (const [stage, durs] of Object.entries(stageDurMs)) {
      if (!durs.length) continue;
      const sorted = [...durs].sort((a, b) => a - b);
      stageDurations[stage] = durs.reduce((a, b) => a + b, 0) / durs.length / 1000;
      stageDurationsP95[stage] = sorted[Math.floor(sorted.length * 0.95)] / 1000;
    }
    return { gateRejections, stageDurations, stageDurationsP95, source: 'telemetry' };
  } catch { return null; }
}

// Research-derived heuristic checks. Each check returns a proposal or null.
// They receive: { runs, ledger, hillClimbState, promptEvolutionState, config, metricsSnapshot }
const RESEARCH_CHECKS = [
  {
    key: 'reflexion:failed-no-reflection',
    source: 'Reflexion (Shinn et al. 2023)',
    check({ runs, ledger }) {
      const items = ledger?.items || {};
      // Items that have failed 2+ times but carry no structured reflection artifact.
      const candidates = Object.entries(items)
        .filter(([, v]) => v.state === 'FAILED' && (v.attempts || 0) >= 2)
        .filter(([id]) => {
          const r = runs.filter((r) => r.id === id);
          return r.every((run) => !run.hasReflection);
        })
        .slice(0, 5)
        .map(([id]) => id);
      if (candidates.length < 2) return null;
      return {
        impact: candidates.length * 12,
        title: `Reflexion: ${candidates.length} multi-failure items have no verbal reflection artifact`,
        detail:
          `Reflexion (Shinn et al. 2023) shows +20% task success when an LLM generates a short ` +
          `verbal "what went wrong and what I'll do differently" message BEFORE each retry attempt. ` +
          `These items have failed ${candidates.map((id) => (ledger.items[id].attempts || 0)).join('/')} times each ` +
          `without a reflection artifact: ${candidates.join(', ')}. ` +
          `Proposed fix: after each FAILED verdict, the orchestrator calls a cheap model (haiku) with ` +
          `the decisive-gate finding + last 10 log lines and stores the reflection as ` +
          `state/items/<id>/reflection.json. The next dispatch reads it and prepends it to the ` +
          `planner context (step 0 of the fixer prompt). Implementation: add orchestrate.mjs ` +
          `\`generateReflection(runResult)\` call in the fail-branch of \`runLane\`, write to ` +
          `state/items/<id>/reflection.json, extend promptpack.mjs to include it.`,
      };
    },
  },
  {
    key: 'self-refine:no-self-critique-pre-commit',
    source: 'Self-Refine (Madaan et al. 2023)',
    check({ runs, config }) {
      // Check if the fixer has a self-critique pass before submitting to gates.
      // Proxy: look at calls/closed — if above 30 and trending flat, self-critique adds value.
      const recent = runs.filter((r) => r.toState === 'CLOSED').slice(-20);
      const callsPerClosed = recent.length > 5
        ? recent.reduce((a, r) => a + (r.stageCount || 1), 0) / recent.length
        : null;
      const hasCritiquePlanned = config?.selfCritique?.enabled;
      if (hasCritiquePlanned || callsPerClosed === null || callsPerClosed < 28) return null;
      return {
        impact: 22,
        title: `Self-Refine: calls/closed=${callsPerClosed.toFixed(1)} plateau — add fixer self-critique pass`,
        detail:
          `Self-Refine (Madaan et al. 2023) adds a CRITIQUE step between the fix and submission: ` +
          `the model reviews its own diff against the acceptance criteria and revises before any gate ` +
          `sees it. Their experiments show 5–20% fewer revision rounds on code tasks. ` +
          `The factory's calls/closed is ${callsPerClosed.toFixed(1)}, flat for the last ${recent.length} closed items. ` +
          `Proposed fix: add a \`self-critique\` stage to factory.js after fix-consolidation: a ` +
          `haiku/sonnet call with the diff + acceptance criteria that returns { issues: string[], verdict: 'ok'|'revise' }. ` +
          `If \`revise\`, re-enter the fix loop once (capped to avoid infinite loops). ` +
          `Gate on \`config.selfCritique.enabled\` (add to orchestrator.config.json).`,
      };
    },
  },
  {
    key: 'tot:plan-branching',
    source: 'Tree of Thought (Yao et al. 2023)',
    check({ runs }) {
      // Proxy: items that fail on architect/developer but succeed on retry with different plan.
      const architectFails = runs.filter(
        (r) => r.toState !== 'CLOSED' && r.decisiveGate === 'gate:architect',
      ).length;
      const architectSuccess = runs.filter(
        (r) => r.toState === 'CLOSED' && r.priorAttemptReuse?.length > 0,
      ).length;
      if (architectFails < 3 || architectFails / Math.max(1, runs.length) < 0.08) return null;
      return {
        impact: architectFails * 8,
        title: `Tree of Thought: ${architectFails} architect-gate failures — add plan-branching`,
        detail:
          `Tree of Thought (Yao et al. 2023) generates 2–3 alternative reasoning branches and ` +
          `evaluates them before committing. Architect-gate failures typically mean the fix plan ` +
          `chose the wrong structural approach. Proposed fix: in the planner phase, generate ` +
          `TWO brief plan sketches (sonnet, parallel), ask the plan-quality-probe to pick the ` +
          `better one, then develop only the winner into the full step-by-step plan. ` +
          `Cost: +1 sonnet call per item (cheap vs the cost of a gate-fail re-run). ` +
          `Implementation: factory.js planner phase, before the quality-probe loop.`,
      };
    },
  },
  {
    key: 'rlaif:gate-verdict-reward-mining',
    source: 'RLHF/RLAIF signal mining',
    check({ runs, config }) {
      // If prompt-evolution is enabled but we have no reward-signal mining from gate verdicts.
      const pEvol = config?.promptEvolution?.enabled;
      const closedWithGateDetails = runs.filter(
        (r) => r.toState === 'CLOSED' && r.gateDetails,
      ).length;
      if (!pEvol || closedWithGateDetails < 10) return null;
      // Propose a richer reward signal: track which fixer prompt phrases correlate with first-pass approval.
      return {
        impact: 15,
        title: `RLAIF: mine gate-verdict signals to inform prompt-evolution fitness`,
        detail:
          `RLHF/RLAIF research shows that dense reward signals (per-step feedback) outperform ` +
          `sparse ones (pass/fail at the end). The factory's prompt-evolution (KI-E286) currently ` +
          `uses binary close-rate as fitness. Proposed enhancement: also reward FIRST-PASS approval ` +
          `rate (no re-fix rounds) as a secondary fitness signal in prompt-evolution. ` +
          `Runs where ALL gates pass in a single attempt get a fitness bonus of +0.3; ` +
          `runs that required a KI-E306 re-fix get a penalty of -0.1. ` +
          `This steers prompt-evolution toward plans that satisfy all gates in one pass. ` +
          `Implementation: extend state/prompt-evolution.json fitness scoring in orchestrate.mjs; ` +
          `count the \`priorAttemptReuse\` field: zero = first-pass.`,
      };
    },
  },
  {
    key: 'star:rationale-bootstrapping',
    source: 'STaR (Zelikman et al. 2022)',
    check({ runs }) {
      // Items that closed on first pass (no retry) — these are the "gold standard" traces.
      const firstPassClosed = runs.filter(
        (r) => r.toState === 'CLOSED' && (!r.priorAttemptReuse || r.priorAttemptReuse.length === 0),
      );
      if (firstPassClosed.length < 5) return null;
      return {
        impact: 10,
        title: `STaR: ${firstPassClosed.length} first-pass closed items — bootstrap rationale library`,
        detail:
          `STaR (Zelikman et al. 2022) bootstraps a rationale library from successful traces and ` +
          `uses them as few-shot examples for future similar tasks. ` +
          `The factory has ${firstPassClosed.length} items that closed on the FIRST attempt with no ` +
          `re-fix rounds — these are high-quality "gold" traces. ` +
          `Proposed fix: after a first-pass CLOSED run, extract the item's plan.md + fix.json ` +
          `summary as a few-shot example in state/rationale-library.json, keyed by ` +
          `{ theme, fixType, layer }. The planner prompt includes the 1–2 closest-theme examples ` +
          `from the library (trimmed to 500 tokens). This is zero-cost retrieval (no API call) ` +
          `and addresses the "cold start" problem for items similar to gold traces.`,
      };
    },
  },
  {
    key: 'calibration:confidence-gating',
    source: 'Calibration (Kadavath et al. 2022)',
    check({ runs, config }) {
      // Check if we have explicit confidence gating on any stage.
      const hasConfidenceGate = config?.cosmeticPatcher?.confidenceThreshold > 0
        || config?.selfCritique?.confidenceThreshold > 0;
      // If the cosmetic patcher (KI-E358) hasn't been upgraded to confidence-gating yet.
      const cosmeticWasFixed = runs.some((r) => r.id === 'FACTORY-KI-E358-VALIDATE' && r.toState === 'CLOSED');
      if (hasConfidenceGate && cosmeticWasFixed) return null;
      return {
        impact: 8,
        title: 'Calibration: generalize confidence gating beyond KI-E358 cosmetic patcher',
        detail:
          `Kadavath et al. (2022) show that LLMs are well-calibrated when asked "Is this correct?" ` +
          `in a format that elicits a confidence score. The KI-E358 cosmetic patcher adds a ` +
          `haiku confidence check before firing (confidence ≥ 0.85 required). The same pattern ` +
          `should extend to: (1) the plan-review probe — gate plan execution on plan confidence ≥ 0.80; ` +
          `(2) the phantom-manifest probe — only flag a manifest phantom if confidence ≥ 0.90 ` +
          `(false positives on this probe abort valid fixes). ` +
          `Each probe already calls() with a typed schema — add a { confidence: number } field ` +
          `to each schema and gate on threshold. Add thresholds to orchestrator.config.json.`,
      };
    },
  },
  // 7. Implementation completeness: phantom-manifest / no-production-code / not-done pattern.
  // Theory: SWE-bench research shows LLMs systematically fail by writing plans without executing
  // them — the most common "fix" pattern on hard tasks is hallucinating code output. The factory
  // addresses this with KI-E118 (phantom manifest detector) but the prompt-level root cause
  // (agents declaring work done without doing it) should be attacked directly.
  {
    key: 'implementation-completeness:not-done-pattern',
    source: 'SWE-bench (Jimenez et al. 2024) — phantom implementation analysis',
    check({ runs }) {
      // Fold-time override runs where the agent CLAIMED success but did no real work.
      const phantomRuns = runs.filter((r) =>
        r.overrideReason === 'fold-override:phantom-manifest' ||
        r.overrideReason === 'fold-override:no-production-code');
      const baselineAbsent = runs.filter((r) => r.overrideReason === 'fold-override:verify-baseline-absent');
      // All "not done" failure modes combined.
      const notDoneTotal = phantomRuns.length + baselineAbsent.length;
      if (notDoneTotal < 1) return null;
      const phantomItems = [...new Set(phantomRuns.map((r) => r.id))];
      const baselineItems = [...new Set(baselineAbsent.map((r) => r.id))];
      return {
        impact: notDoneTotal * 25,
        title: `Implementation gap: ${notDoneTotal} run(s) where the agent declared work done without doing it`,
        detail:
          `SWE-bench research (Jimenez et al. 2024) identifies "phantom implementation" as the primary ` +
          `failure mode on hard coding tasks: the model outputs a plan and marks it complete without ` +
          `executing it. The factory's fold-time probes catch two variants: ` +
          `(a) PHANTOM MANIFEST (KI-E118): agent listed files in fix.json that the worktree diff never ` +
          `touched — affected items: ${phantomItems.join(', ') || 'none'}. ` +
          `(b) NO-PRODUCTION-CODE: diff only touched test files, no source change — ` +
          `affected items: ${baselineItems.join(', ') || 'none'}. ` +
          `All review gates passed (APPROVED), wasting the full gate-band cost before fold rejection. ` +
          `Proposed multi-layer fix: (1) Add a "self-verify" step to the fixer workflow BEFORE writing ` +
          `fix.json: a cheap probe (haiku) that reads the actual worktree diff and confirms each ` +
          `declared file appears in it — fails fast if any is missing. (2) In the planner step, add ` +
          `an explicit constraint: "the fix MUST include at least one non-test src/ file change unless ` +
          `the item's goal is test-only." (3) Strengthen the KI-E118 pre-flight instructions so the ` +
          `fixer explicitly grep-checks each path before adding it to fix.json. (4) Add a ` +
          `plan-commitment probe variant that checks the fixer's declared files against the worktree ` +
          `diff BEFORE dispatching to the gate band (cheap, pre-band, saves the full gate cost).`,
      };
    },
  },
  // 8. Verify-baseline-absent as a systemic process discipline failure (separate from phantom).
  // Theory: Reflexion research shows that capturing the "before" state is as important as
  // capturing the "after" — without a baseline, you can't prove improvement. The factory's
  // fold-time override for this is correct but fires too late (after full gate spend).
  {
    key: 'process-discipline:verify-baseline-mandatory',
    source: 'Reflexion (Shinn et al. 2023) — before/after state capture discipline',
    check({ runs }) {
      const baselineAbsent = runs.filter((r) => r.overrideReason === 'fold-override:verify-baseline-absent');
      if (baselineAbsent.length < 2) return null;
      const items = [...new Set(baselineAbsent.map((r) => r.id))];
      return {
        impact: baselineAbsent.length * 18,
        title: `Verify-baseline discipline: ${baselineAbsent.length} run(s) skipped the RED capture step (${items.length} item(s))`,
        detail:
          `Reflexion (Shinn et al. 2023) and basic test engineering both require a "before" state ` +
          `(the RED baseline) to prove a fix worked. The fold-time override catches missing baselines ` +
          `but only AFTER the full gate-band cost has been spent — every gate reviewed a fix that ` +
          `could never be verified. ${baselineAbsent.length > 2 ? 'This is a SYSTEMIC pattern' : 'This has happened ' + baselineAbsent.length + '+ times'} ` +
          `on items: ${items.join(', ')}. ` +
          `Proposed fix: (1) Add a mandatory step-0 gate in factory.js BEFORE any code change: ` +
          `"run verify-red and capture verify-red.txt — if this step is missing at gate time, ` +
          `the run fails immediately (no gate band spent)." (2) Add a cheap pre-band probe that ` +
          `checks verify-red.txt exists and has exit=1 content (confirm it IS a failing baseline, ` +
          `not an empty file) before any review gate sees the diff. (3) Instruct the fixer prompt ` +
          `that verify-red capture is step 0, non-negotiable, and that the probe will kill the run ` +
          `early if it is missing — making the cost of skipping higher than the cost of doing it.`,
      };
    },
  },
  // 9. KI-E366: Telemetry-driven stage anomaly detection.
  // Fires when a stage has an average duration ≥ 5× the median — signals a runaway outlier or
  // systematic timeout that burns wall-clock time and context budget.
  {
    key: 'telemetry:slow-stage-detect',
    source: 'Telemetry analysis (KI-E366)',
    check({ metricsSnapshot }) {
      if (!metricsSnapshot || !metricsSnapshot.stageDurations) return null;
      const entries = Object.entries(metricsSnapshot.stageDurations).filter(([, v]) => v > 0);
      if (entries.length < 2) return null;
      const sorted = [...entries].sort((a, b) => a[1] - b[1]);
      const median = sorted[Math.floor(sorted.length / 2)][1];
      const outliers = entries
        .filter(([, avg]) => avg > Math.max(3600, median * 5))
        .sort((a, b) => b[1] - a[1]);
      if (!outliers.length) return null;
      const [stage, avg] = outliers[0];
      const p95 = metricsSnapshot.stageDurationsP95?.[stage];
      const ratio = (avg / Math.max(1, median)).toFixed(1);
      return {
        impact: 5,
        title: `Telemetry: stage \`${stage}\` avg ${(avg / 60).toFixed(0)} min (${ratio}× median)`,
        detail:
          `Live telemetry events show \`${stage}\` averaging ${(avg / 60).toFixed(0)} minutes — ` +
          `${ratio}× the per-stage median (${(median / 60).toFixed(0)} min)` +
          (p95 ? `, P95 = ${(p95 / 60).toFixed(0)} min` : '') + `. ` +
          `A single runaway item or a recurrent timeout is likely. ` +
          `Proposed fix: (1) add a per-stage hard wall-clock timeout to the orchestrator (already planned for KI-E3xx); ` +
          `(2) investigate events.jsonl — filter \`stage=="${stage}"\` and sort by \`durMs\` to find the offending item; ` +
          `(3) check whether the stage issues a subagent with no bounded scope (e.g. an unbounded file search).`,
      };
    },
  },
];

function readRuns(p) {
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (line.trim()) { try { out.push(JSON.parse(line)); } catch { /* torn */ } }
  }
  return out;
}

function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function computeResearchProposals(runs, ledger, config, stateDir, metricsSnapshot = null) {
  const ctx = {
    runs,
    ledger: ledger || { items: {} },
    config: config || {},
    hillClimbState: readJson(join(stateDir, 'hill-climb.json')),
    promptEvolutionState: readJson(join(stateDir, 'prompt-evolution.json')),
    metricsSnapshot,
  };
  const proposals = [];
  for (const check of RESEARCH_CHECKS) {
    try {
      const p = check.check(ctx);
      if (p) proposals.push({ ...p, key: check.key, source: check.source });
    } catch { /* graceful skip */ }
  }
  return proposals.sort((a, b) => b.impact - a.impact);
}

export function runResearchDigest(root) {
  const reportsDir = join(root, 'reports');
  const queueDir = join(root, 'queue');
  const stateDir = join(root, 'state');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(queueDir, { recursive: true });

  const runs = readRuns(join(reportsDir, 'runs.jsonl'));
  const ledger = readJson(join(stateDir, 'ledger.json'), { items: {} });
  const config = readJson(join(root, 'config', 'orchestrator.config.json'), {});

  // KI-E366: enrich proposals with local telemetry data (gate rejections + stage durations).
  const telemetrySnapshot = readTelemetrySnapshot(root);
  const proposals = computeResearchProposals(runs, ledger, config, stateDir, telemetrySnapshot);

  // Dedup against already-queued research proposal keys.
  const researchStatePath = join(stateDir, 'research-digest.json');
  let seen = {};
  try { seen = readJson(researchStatePath)?.queued || {}; } catch { /* fresh */ }

  const fresh = proposals.filter((p) => !seen[p.key]).slice(0, 2);

  // Write the full research backlog report.
  const now = new Date().toISOString();
  const R = [
    '# Factory Research-Informed Improvement Backlog',
    '',
    `_Generated ${now} · ${runs.length} recorded run(s) · sources: Reflexion, Self-Refine, ToT, RLAIF, STaR, Calibration_`,
    '',
    'Proposals derived from AI self-improvement literature, mapped onto the factory\'s current failure modes.',
    '',
  ];
  if (!proposals.length) {
    R.push('_No research gaps detected (factory already implements the checked patterns or insufficient run data)._');
  } else {
    for (const p of proposals) {
      R.push(
        `### ${p.title}`,
        '',
        `**Source:** ${p.source}`,
        `**Impact score:** ${p.impact}${seen[p.key] ? ' · _(already queued)_' : ''}`,
        '',
        p.detail,
        '',
      );
    }
  }
  writeFileSync(join(reportsDir, 'RESEARCH-DIGEST.md'), R.join('\n') + '\n');

  // Queue fresh proposals.
  if (fresh.length) {
    const stamp = now.replace(/[:.]/g, '-');
    const qPath = join(queueDir, `factory-improvement-research-${stamp}.md`);
    const Q = [
      '---',
      'kind: factory-improvement',
      `generated: ${now}`,
      'source: research-digest.mjs (KI-E359)',
      '---',
      '',
      '# Research-informed factory-improvement proposals',
      '',
      'Each becomes a gated work item via `driver ingest-improvements`. The fixes are normal',
      'factory-pipeline changes (planner → fixer → gates → PR) — research is the theory, the',
      'factory\'s own gate suite validates the implementation.',
      '',
    ];
    for (const p of fresh) {
      Q.push(`## ${p.title}`, '', `- key: \`${p.key}\``, `- source: ${p.source}`, `- impact: ${p.impact}`, '', p.detail, '');
      seen[p.key] = now;
    }
    writeFileSync(qPath, Q.join('\n') + '\n');
    writeFileSync(researchStatePath, JSON.stringify({ queued: seen, lastRun: now }, null, 2));
  }

  return { proposals, fresh: fresh.length };
}

// CLI: `node research-digest.mjs [root]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const cwd = process.cwd();
  const cwdGuess = cwd.endsWith('ai-factory') ? cwd : join(cwd, '_bmad-output', 'ai-factory');
  const root = process.argv[2] || process.env.FACTORY_ROOT || cwdGuess;
  const r = runResearchDigest(root);
  console.log(`research-digest: ${r.proposals.length} proposal(s), ${r.fresh} newly queued`);
}
