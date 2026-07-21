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
