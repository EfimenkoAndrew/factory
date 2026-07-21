// Prompt-enrichment helpers (2026-07-18, cache-strategic prompts): built by the DRIVER at group
// time (Node side — the Workflow runtime has no fs) and inlined into the emitted batch so every
// stage agent's prompt is self-contained:
//   - readRoleBriefs: agents/*.md inlined once per batch -> compose() embeds the role brief text
//     instead of a "read it from the repo root" pointer. Kills one Read round-trip per agent
//     (~17/band), the repo-root path-fragility class (KI-L33), and mid-run brief drift (a resumed
//     or long-running band always briefs from the GROUP-time snapshot, matching how factory.js
//     itself is inlined at group time — KI-L46 consistency).
//   - buildDocMap: a per-item section index (## / ### headings + line numbers) of the target's
//     reference docs (doc/data-flows/<target>.md, <target>/CONTEXT.md, <target>/AGENTS.md) so
//     agents Read ONLY the sections they need via offset/limit instead of whole 500-1000-line
//     docs (the owner's "be strategic in caching with data flows" directive: the docs stay on
//     disk; the MAP rides in the shared per-item prompt prefix).
// Pure w/ injectable io for the selftest; best-effort by contract (a missing doc yields no entry,
// never a throw — prompt enrichment must never block a group).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HEADING_CAP = 40;      // max headings per doc in the map (a data-flow doc can have 100s)
const HEADING_LEN = 90;      // per-heading text bound
const BRIEF_CAP = 12000;     // per-brief char bound (largest live brief is ~9k)

// Extract '## ' / '### ' headings with 1-based line numbers -> ['§ <text> @L<n>', ...] (capped).
export function extractHeadings(text, cap = HEADING_CAP) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    const m = /^(#{2,3})\s+(.+)/.exec(lines[i]);
    if (m) out.push('§ ' + m[2].trim().slice(0, HEADING_LEN) + ' @L' + (i + 1));
  }
  return out;
}

// Section index for the target's reference docs. Returns [] when none exist (doc-less target).
// One entry per existing doc: '<relpath> :: § A @L10 · § B @L42 · ...'.
export function buildDocMap(repoRoot, target, io) {
  const rf = (io && io.readFileSync) || readFileSync;
  const ex = (io && io.existsSync) || existsSync;
  if (!target) return [];
  const cands = ['doc/data-flows/' + target + '.md', target + '/CONTEXT.md', target + '/AGENTS.md'];
  const map = [];
  for (const rel of cands) {
    try {
      const p = join(repoRoot, rel);
      if (!ex(p)) continue;
      const hs = extractHeadings(rf(p, 'utf8'));
      map.push(hs.length ? rel + ' :: ' + hs.join(' · ') : rel);
    } catch { /* best-effort — skip unreadable doc */ }
  }
  return map;
}

// Read every agents/<role>.md into { role: briefText } (each capped). Returns {} on any dir-level
// failure — the factory's compose() then falls back to the legacy read-it-yourself pointer.
export function readRoleBriefs(agentsDir, io) {
  const rf = (io && io.readFileSync) || readFileSync;
  const rd = (io && io.readdirSync) || readdirSync;
  const briefs = {};
  try {
    for (const f of rd(agentsDir)) {
      if (!/\.md$/i.test(f)) continue;
      try { briefs[f.replace(/\.md$/i, '')] = String(rf(join(agentsDir, f), 'utf8')).slice(0, BRIEF_CAP); }
      catch { /* skip one unreadable brief */ }
    }
  } catch { return {}; }
  return briefs;
}
