// Graph files[] path auditor (KI-L27). A stale files[] path (audit-artifact-relative path,
// renamed directory, bare basename) defeats the within-batch file-lock (two items editing the
// same real file don't collide → serial integration can silently drop one fix) and misdirects
// the fixer + the fold-time debris whitelist. Root-cause class behind KI-L23 (ServiceD
// `Infrastructure/Common/` vs real `ExceptionHandling/`) and ITEM-C0 (paths relative to the
// audit dir, not the repo root).
//
// classifyFilesEntry maps ONE files[] entry to:
//   ok              — exists on disk (file or dir; trailing slash tolerated)
//   creation-target — nothing tracked matches by basename; the fix is expected to CREATE it
//   stale           — does not exist, but exactly one tracked file matches by basename
//                     (a unique match under the item's target dir wins over global counts)
//                     → a rewrite is proposed
//   ambiguous       — multiple tracked files match by basename with no unique target-dir match;
//                     needs a human (report-only; NEVER auto-rewritten)
//
// Pure: all I/O is injected (existsOnDisk fn + a prebuilt basename index) so _selftest.mjs can
// exercise every branch without a repo.
export function classifyFilesEntry(entry, opts) {
  const p = String(entry || '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p) return { status: 'empty' };
  if (opts.existsOnDisk(p)) return { status: 'ok' };
  const base = p.split('/').pop();
  const candidates = opts.byBasename.get(base) || [];
  const t = opts.targetDir;
  const inTarget = t ? candidates.filter((c) => c.startsWith(t + '/')) : [];
  // A unique same-service match wins even over a plausible parent: if the same-named file already
  // exists in the item's own service, the entry almost surely MEANT that file (renamed dir /
  // missing src segment), not a new sibling.
  if (inTarget.length === 1) return { status: 'stale', rewrite: inTarget[0] };
  // Plausible as-written: a pathed entry whose parent dir exists is a creation target (the fix
  // creates the file there) — global basename collisions (every service has a Dockerfile /
  // AGENTS.md / CONTEXT.md) are coincidence, not evidence of staleness. A bare basename never
  // takes this branch (it names an existing file, not a deliberate creation path).
  if (p.includes('/')) {
    const parent = p.split('/').slice(0, -1).join('/');
    if (opts.existsOnDisk(parent)) return { status: 'creation-target' };
  }
  if (!candidates.length) return { status: 'creation-target' };
  if (candidates.length === 1) return { status: 'stale', rewrite: candidates[0] };
  return { status: 'ambiguous', candidates: candidates.slice(0, 8) };
}

// basename → [tracked paths] index from a `git ls-files` listing.
export function buildBasenameIndex(trackedPaths) {
  const m = new Map();
  for (const f of trackedPaths) {
    if (!f) continue;
    const b = f.split('/').pop();
    if (!m.has(b)) m.set(b, []);
    m.get(b).push(f);
  }
  return m;
}

// KI-E22 (2026-07-21, improvement-analysis P4) — acceptance-surface lint: the KI-E16 ledger check
// generalized. The general defect shape (the ITEM-M7 controller-clause class, cycle 46): the
// `acceptance` NAMES surfaces the fix must touch while `files[]` omits them — the within-batch
// file-lock then has nothing to serialize on, a sibling holds the real lock, and the fixer
// (correctly honouring the lock set) is structurally FORBIDDEN from meeting the acceptance; the
// opus band discovers it at full price. Heuristic: extract path-like tokens + PascalCase type
// names from `acceptance`; when a token resolves to a real tracked repo file (target-dir-unique
// wins, mirroring classifyFilesEntry) that files[] does not carry (by path or basename), report a
// gap. ADVISORY only (a WARN at graph-audit + group time, never a gate) — imprecision is
// acceptable by design. Pure: all IO injected, selftest-covered.
export function acceptanceSurfaceGaps(wi, opts) {
  const acceptance = String((wi && wi.acceptance) || '');
  const files = (wi && wi.files) || [];
  const norm = (f) => String(f || '').replace(/^\.\//, '');
  const havePaths = new Set(files.map(norm));
  const haveBases = new Set(files.map((f) => norm(f).split('/').pop()));
  const gaps = [];
  const seen = new Set();
  const consider = (token, resolved) => {
    if (havePaths.has(resolved) || haveBases.has(resolved.split('/').pop())) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    gaps.push({ token, resolved });
  };
  // 1. explicit path-like tokens (slash + extension) that exist on disk
  for (const m of acceptance.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,6}/g)) {
    const p = norm(m[0]);
    if (opts.existsOnDisk(p)) consider(m[0], p);
  }
  // 2. PascalCase type names (>=2 humps) resolving to a unique tracked .cs file — a
  //    target-dir-unique match wins; a globally-unique match is accepted; anything ambiguous is
  //    silently skipped (too noisy for an advisory lint).
  for (const m of acceptance.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) {
    const cand = opts.byBasename.get(m[0] + '.cs') || [];
    const t = opts.targetDir;
    const inTarget = t ? cand.filter((c) => c.startsWith(t + '/')) : [];
    const hit = inTarget.length === 1 ? inTarget[0] : (cand.length === 1 ? cand[0] : null);
    if (hit) consider(m[0], hit);
  }
  return gaps;
}
