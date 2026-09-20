export { completeCommand } from '../lib/stage-evidence.mjs';

export function lintCandidates(output, kind) {
  const name = kind === 'leftover' ? 'LEFTOVER' : 'LEDGER-ANCHOR';
  if (new RegExp('^FACTORY::' + name + '-(?:SCAN-)?ERROR::', 'm').test(output)) throw new Error(name + ' scanner error');
  const counts = [...String(output).matchAll(new RegExp('^FACTORY::' + name + '::(\\d+)\\r?$', 'gm'))];
  if (counts.length !== 1) throw new Error(name + ' missing/duplicate count');
  const hits = [];
  for (const line of String(output).split(/\r?\n/)) {
    let m;
    if (kind === 'leftover' && (m = /^FACTORY::LEFTOVER-HIT::(.*?)::(.*?)::(.*)$/.exec(line))) hits.push({ file: m[1], lexeme: m[2], text: m[3] });
    if (kind === 'ledger' && (m = /^FACTORY::LEDGER-ANCHOR-DUP-HIT::(.*?)::(.*?)::(.*?)::(.*)$/.exec(line))) hits.push({ kind: 'duplicate', anchor: m[1], level: m[2], fileA: m[3], fileB: m[4] });
    if (kind === 'ledger' && (m = /^FACTORY::LEDGER-ANCHOR-TAG-HIT::(.*?)::(.*?)::(true|false)$/.exec(line))) hits.push({ kind: 'tag', anchor: m[1], file: m[2], tagFound: m[3] === 'true' });
  }
  if (Number(counts[0][1]) !== hits.length) throw new Error(name + ' count/payload mismatch');
  return hits;
}

export function guardMechanical(progress, step) {
  const allowed = step === 'checkpoint' ? ['checkpoint', 'done'] : step === 'verify' ? ['verify', 'final_verify'] : [step];
  if (!allowed.includes(progress.phase)) throw new Error('mechanical ' + step + ' invalid in phase ' + progress.phase);
  if (progress.pendingSet) throw new Error('mechanical command while agent submissions are pending');
}
