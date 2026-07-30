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
//   - readRepoProfiles (KI-E60): agents/repo-profiles/<target>.md inlined once per batch, same
//     shape as readRoleBriefs -> compose() layers the target's repo-specific style facts ON TOP
//     of the universal agents/*.md brief (never in place of it). A repo with no profile file is
//     completely unaffected — the universal brief alone remains authoritative, exactly as before
//     this mechanism existed (KI-E56: a universal brief cannot correctly describe every real
//     repo's own conventions, e.g. NUnit vs xUnit+FluentAssertions).
// Pure w/ injectable io for the selftest; best-effort by contract (a missing doc yields no entry,
// never a throw — prompt enrichment must never block a group).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HEADING_CAP = 40;      // max headings per doc in the map (a data-flow doc can have 100s)
const HEADING_LEN = 90;      // per-heading text bound
const BRIEF_CAP = 12000;     // per-brief char bound (largest live brief is ~9k)
// Repo profiles get their OWN cap: real profiles run 8-26KB (a BRIEF_CAP slice silently dropped
// 30-53% of 3 of the 4 first live profiles — tail sections vanished with no warning). Exported so
// the opencode port's compose (which reads profiles off disk itself) applies the IDENTICAL bound —
// both runtimes must inject the same profile content for the same target (PR#9 review).
export const PROFILE_CAP = 30000;

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

// Read every agents/repo-profiles/<target>.md into { target: profileText } (each capped at
// PROFILE_CAP — larger than BRIEF_CAP because real profiles run 8-26KB). Returns {} on any
// dir-level failure (the directory not existing is the common case — most targets have no profile
// yet) — compose() then simply omits the repo-specific overlay and every prompt behaves exactly as
// it did before this profile existed. Profiles are HOST data: the dir ships gitignored except a
// README + a fictional example (see agents/repo-profiles/README.md) — real profiles live only in
// each host mount, never in this engine repo (KI-E26).
export function readRepoProfiles(profilesDir, io) {
  const rf = (io && io.readFileSync) || readFileSync;
  const rd = (io && io.readdirSync) || readdirSync;
  const profiles = {};
  try {
    for (const f of rd(profilesDir)) {
      if (!/\.md$/i.test(f)) continue;
      if (/^(README|_example[^/]*)\.md$/i.test(f)) continue; // docs/template, never a real target key
      try { profiles[f.replace(/\.md$/i, '')] = String(rf(join(profilesDir, f), 'utf8')).slice(0, PROFILE_CAP); }
      catch { /* skip one unreadable profile */ }
    }
  } catch { return {}; }
  return profiles;
}
