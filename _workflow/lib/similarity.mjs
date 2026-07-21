// Similarity signatures + clustering — the ONE definition of "these findings are the same
// change-shape" shared by cluster.mjs (root-cause triage report) and driver.mjs (`suggest`
// batch planning + `group` batch-pattern stamping). Owner directive 2026-07-04: "plan similar
// work in one batch so that the changes are identical / similar" — batching same-pattern items
// makes the N fixes structurally uniform (one review shape, convergent gates, one commit story).
// Pure functions: items in, clusters/pattern text out — the self-test exercises everything
// without a filesystem.

// ---- keyword signature -------------------------------------------------------------------------
export const STOP = new Set(('the a an of for or and to in on is are no not missing absent with without both all only '
  + 'its their this that has have can unset set stale never zero from every service services when then else '
  + 'into out over under across each any some more most less than via using used uses use new old does not- '
  + 'still also been being was were will would should could may might must shall').split(/\s+/));
// service / infra tokens that are target-specific noise, not the systemic pattern
export const NOISE = new Set(('search redis postgres rabbitmq minio scylladb seaweedfs admin identity users payments '
  + 'orders products media messaging notification analytics compliance casefiles config finance risk audit '
  + 'marketplace shop portal erika crypto auth iam shopadmin webportal adminportal service svc '
  + 'i2p i2pd mailservice').split(/\s+/));

export function sig(item) {
  const words = String(item.title || '').toLowerCase().replace(/[^a-z0-9 -]/g, ' ').split(/\s+/);
  const kw = new Set();
  for (let w of words) {
    w = w.replace(/^-+|-+$/g, '');
    if (w.length > 3 && !STOP.has(w) && !NOISE.has(w) && !/^\d+$/.test(w)) kw.add(w);
  }
  return kw;
}

export function jaccard(a, b) {
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

// The clustering rule (verbatim from cluster.mjs, extracted 2026-07-04): two findings share a
// root-cause pattern when their title signatures overlap strongly — high Jaccard OR >=2 shared
// distinctive keywords. Same-theme scoping is the CALLER's job (clusterBySimilarity below).
export const SIM_JACCARD = 0.5;
export const SIM_SHARED = 2;
export function similarSigs(a, b) {
  let shared = 0; for (const x of a) if (b.has(x)) shared++;
  return jaccard(a, b) >= SIM_JACCARD || shared >= SIM_SHARED;
}

// ---- clustering (theme-scoped union-find) --------------------------------------------------------
// Returns an array of clusters; each cluster is an array of the ORIGINAL item objects, input order
// preserved. Items only merge within the same theme (a deploy-script pattern and a crypto pattern
// sharing the word "missing entry" must never batch together).
export function clusterBySimilarity(items) {
  const arr = items || [];
  const parent = arr.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  const sigs = arr.map(sig);
  const byTheme = {};
  arr.forEach((it, i) => { (byTheme[it.theme || '?'] ||= []).push(i); });
  for (const idxs of Object.values(byTheme)) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (similarSigs(sigs[idxs[a]], sigs[idxs[b]])) union(idxs[a], idxs[b]);
      }
    }
  }
  const groups = {};
  arr.forEach((it, i) => { (groups[find(i)] ||= []).push(it); });
  return Object.values(groups);
}

// Cluster label = the most common distinctive keywords across members (display/report aid).
export function sharedLabel(items, topN) {
  const kwCount = {};
  for (const it of items || []) for (const w of sig(it)) kwCount[w] = (kwCount[w] || 0) + 1;
  return Object.entries(kwCount).sort((a, b) => b[1] - a[1]).slice(0, topN || 4).map(([w]) => w).join(' / ') || '(misc)';
}

// ---- batch pattern (group-time stamp) -------------------------------------------------------------
// STRICT all-pairs test: only when EVERY pair in the batch is same-theme + similar does the batch
// get a shared-pattern stamp (a chain A~B~C where A!~C would produce a mushy pattern that misleads
// the fixers more than it helps). Returns the pattern text, or null for a heterogeneous batch.
export function batchPatternFor(items) {
  const arr = items || [];
  if (arr.length < 2) return null;
  const sigs = arr.map(sig);
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if ((arr[i].theme || '?') !== (arr[j].theme || '?') || !similarSigs(sigs[i], sigs[j])) return null;
    }
  }
  const kwCount = {};
  for (const s of sigs) for (const w of s) kwCount[w] = (kwCount[w] || 0) + 1;
  const everywhere = Object.entries(kwCount).filter(([, n]) => n === arr.length).map(([w]) => w);
  const top = (everywhere.length >= 2 ? everywhere : Object.entries(kwCount).sort((a, b) => b[1] - a[1]).map(([w]) => w)).slice(0, 6);
  const targets = [...new Set(arr.map((it) => it.target))];
  return 'same change-shape across ' + arr.length + ' sibling item(s) / ' + targets.length + ' target(s) ['
    + targets.join(', ') + ']; theme=' + (arr[0].theme || '?') + '; shared signature: ' + top.join(' ');
}
