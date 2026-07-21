#!/usr/bin/env node
// Build-time audit gate — "shift the gates left". A standalone, CI-able, DETERMINISTIC linter (no LLM, no
// cost) that scans only the ADDED lines of a diff for the anti-patterns the .claude/rules/*.md codify, so a
// NEW violation is caught at PR/build time instead of accumulating into the next audit. Exits non-zero on
// any CRITICAL/HIGH so a CI step or pre-push hook can block. The factory's LLM review band is the deep,
// expensive net; this is the cheap, fast, every-PR net that keeps the backlog from growing back.
//
//   node _bmad-output/ai-factory/_workflow/audit-diff.mjs [--base <ref>] [--staged]
//     --base <ref>   diff against <ref> (e.g. origin/master). Default: working-tree changes vs HEAD.
//     --staged       only staged changes (pre-commit hook use).
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const base = (() => { const i = argv.indexOf('--base'); return i >= 0 ? argv[i + 1] : null; })();
const staged = argv.includes('--staged');

function git(args) { try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (e) { return (e.stdout || '').toString(); } }

// Rules: { id, sev, when(file)->bool, test(line)->bool, msg }. `when` scopes by path; `test` matches an
// ADDED line. Conservative — each rule is anchored to keep false positives low. Sourced from .claude/rules/*.
const isCs = (f) => f.endsWith('.cs');
const isController = (f) => /Controller\.cs$/.test(f);
const isHandler = (f) => /Handler\.cs$/.test(f);
const isCsproj = (f) => f.endsWith('.csproj');
const isK8sBase = (f) => /k8s\/base\/.*\.ya?ml$/.test(f) && !/overlays?\//.test(f);
const isProgram = (f) => /Program\.cs$/.test(f);

// Strip a diff line down to its CODE before matching: skip pure comment lines, and blank out string/char
// literal CONTENTS so an anti-pattern mentioned only in a comment or a string (e.g. an exception MESSAGE
// that NAMES the API it forbids) is not a false match. Returns null when the whole line is a comment.
// This is what makes audit-diff precise enough to be a BLOCKING gate (false positives get a gate disabled).
function codeOf(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#') || t.startsWith('<!--')) return null;
  return line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
}

const RULES = [
  { id: 'AUTHZ-BARE', sev: 'HIGH', when: isController, test: (l) => /^\s*\[Authorize\]\s*$/.test(l),
    msg: 'bare [Authorize] — use policy-based [Authorize(Policy = AuthorizationPolicies.X)] (security.md AP#6/#18)' },
  { id: 'AUTHZ-LITERAL', sev: 'MEDIUM', when: isCs, test: (l) => /\[Authorize\(Policy\s*=\s*"/.test(l),
    msg: 'string-literal policy name — use a typed AuthorizationPolicies constant (security.md AP#11)' },
  { id: 'IMG-LATEST', sev: 'HIGH', when: isK8sBase, test: (l) => /image:\s*\S+:latest\b/.test(l),
    msg: ':latest image tag in k8s/base — pin a SHA/semver (deploy-verification.md)' },
  { id: 'SECRET-CHANGEME', sev: 'HIGH', when: (f) => /k8s\/.*\.ya?ml$/.test(f), test: (l) => /CHANGE_ME/.test(l),
    msg: 'CHANGE_ME placeholder secret — use REPLACE_WITH_32_PLUS_… + a startup guard (security.md AP#16)' },
  { id: 'PKG-VERSION', sev: 'MEDIUM', when: isCsproj, test: (l) => /<PackageReference[^>]*\bVersion=/.test(l),
    msg: 'Version= in .csproj — versions belong in Directory.Packages.props (code-style.md)' },
  { id: 'OUTBOX-BYPASS', sev: 'HIGH', when: isCs, test: (l) => /(?<![.\w])bus\.Publish\s*\(/.test(l),
    msg: 'bus.Publish bypasses the outbox — publish via the domain event / IPublishEndpoint inside the txn (dataflow.md)' },
  { id: 'IDEMPOTENCY-RANDOM', sev: 'HIGH', when: isCs, test: (l) => /MessageId\??\.ToString\(\)\s*\?\?\s*Guid\.NewGuid/.test(l),
    msg: 'non-deterministic idempotency key (Guid.NewGuid fallback) — build a deterministic key from message fields (dataflow.md)' },
  { id: 'TLS-NOVERIFY', sev: 'HIGH', when: isCs, test: (l) => /--no-verify-ssl/.test(l),
    msg: '--no-verify-ssl disables TLS validation — never outside Development (security.md AP#17)' },
  // MEDIUM (advisory, non-blocking): the legitimate pattern assigns this callback INSIDE an explicit
  // `if (IsDevelopment())` guard (the line-level linter cannot see that guard, so a blocking HIGH would
  // false-block the documented dev-only portal pattern — AuthPortal/AdminPortal Program.cs). The
  // reviewer / the factory security gate confirms the guard with full context.
  { id: 'TLS-DANGEROUS-CB', sev: 'MEDIUM', when: isCs, test: (l) => /DangerousAcceptAnyServerCertificateValidator/.test(l),
    msg: 'DangerousAcceptAnyServerCertificateValidator — confirm it sits inside an explicit IsDevelopment() guard; never in a production path (security.md AP#17)' },
  { id: 'HTTPS-META-OFF', sev: 'MEDIUM', when: isCs, test: (l) => /RequireHttpsMetadata\s*=\s*false/.test(l),
    msg: 'RequireHttpsMetadata=false — dev-only; never in production paths (security.md AP#4)' },
  { id: 'DIRECT-SAVE', sev: 'MEDIUM', when: isHandler, test: (l) => /\bdbContext\.SaveChangesAsync\b/.test(l),
    msg: 'dbContext.SaveChangesAsync in a handler — go through IUnitOfWork.SaveChangesAsync (service-design.md)' },
  { id: 'NS-BLOCK', sev: 'LOW', when: isCs, test: (l) => /^namespace\s+[\w.]+\s*$/.test(l.trimEnd()) === false && /^namespace\s+[\w.]+\s*\{/.test(l),
    msg: 'block-scoped namespace — use a file-scoped namespace (code-style.md)' },
  { id: 'SCOPE-TAX', sev: 'HIGH', when: isCs, test: (l) => /\b(TaxRate|TaxAmount|TaxJurisdiction|TaxableAmount|IsTaxOfficer)\b/.test(l),
    msg: 'tax surface — the marketplace has NO tax responsibility (product-scope.md §2). HARD STOP.' },
  { id: 'SCOPE-FEE', sev: 'HIGH', when: isCs, test: (l) => /FeeType\.ServiceFee\b/.test(l),
    msg: 'FeeType.ServiceFee / purchase fee — forbidden (product-scope.md §3/§5). HARD STOP.' },
  { id: 'SCOPE-SAR', sev: 'HIGH', when: isCs, test: (l) => /\b(SuspiciousActivityReport|ReferToAuthorities|TaxReportGenerator)\b/.test(l),
    msg: 'SAR / government-reporting surface — forbidden (product-scope.md §4). HARD STOP.' },
];

// ONE combined diff — NOT per-file. A per-file `git diff -- <f>` loop spawns O(changed-files) subprocesses
// and hangs for minutes when the base is a long-lived branch (thousands of files). A single `git diff` we
// parse by its `+++ b/<path>` file headers is O(1) git spawns and fast for any base.
const diffArgs = staged ? ['diff', '--cached', '--unified=0']
  : (base ? ['diff', base, '--unified=0'] : ['diff', '--unified=0', 'HEAD']);
const diff = git(diffArgs);

const findings = [];
const seen = new Set();
let curFile = null, applicable = [], line = 0;
for (const raw of diff.split('\n')) {
  // file section header: `+++ b/<path>` (a deleted file is `+++ /dev/null` → curFile stays null → skipped)
  if (raw.startsWith('+++ ')) {
    const m = raw.match(/^\+\+\+ b\/(.+)$/);
    curFile = m ? m[1] : null;
    if (curFile) { seen.add(curFile); applicable = RULES.filter((r) => r.when(curFile)); }
    else applicable = [];
    continue;
  }
  if (raw.startsWith('--- ') || raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('rename ') || raw.startsWith('similarity ')) continue;
  const hm = raw.match(/^@@ .*\+(\d+)/); if (hm) { line = parseInt(hm[1], 10); continue; }
  if (curFile && applicable.length && raw.startsWith('+')) {
    const content = raw.slice(1);
    const code = codeOf(content); // null = comment line (skip); else string/char literals blanked
    if (code !== null) for (const r of applicable) if (r.test(code)) findings.push({ file: curFile, line, id: r.id, sev: r.sev, msg: r.msg, code: content.trim().slice(0, 100) });
    line++;
  }
}
const files = [...seen];

const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
findings.sort((a, b) => order[a.sev] - order[b.sev]);
const blocking = findings.filter((x) => x.sev === 'CRITICAL' || x.sev === 'HIGH');

if (!findings.length) {
  console.log(`audit-diff: clean — ${files.length} changed file(s), 0 violations on added lines.`);
  process.exit(0);
}
console.log(`audit-diff: ${findings.length} violation(s) on added lines (${blocking.length} blocking):\n`);
for (const x of findings) console.log(`  [${x.sev}] ${x.file}:${x.line}  ${x.id}\n      ${x.msg}\n      + ${x.code}`);
console.log(`\n${blocking.length ? 'BLOCK' : 'WARN'}: ${blocking.length} CRITICAL/HIGH, ${findings.length - blocking.length} MEDIUM/LOW.`);
console.log('(deterministic pre-check; the factory LLM review band is the deep net. Fix or justify before merge.)');
process.exit(blocking.length ? 1 : 0);
