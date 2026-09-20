#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { freezeExperiment, validateFrozenExperiment, blindPacket, reportExperiment, renderExperimentReport } from './lib/calibration.mjs';
import { aggregateObservations, renderObservationReport, makeObservation } from './lib/observations.mjs';

const help = `Offline calibration (read-only; stdout output; no agents, network, git or evidence writes)
  node _workflow/calibrate.mjs freeze <input.json>
  node _workflow/calibrate.mjs validate <frozen.json>
  node _workflow/calibrate.mjs blind <frozen.json> <submissions.json>
  node _workflow/calibrate.mjs report <frozen.json> <submissions.json> <adjudications.json> [--json]
  node _workflow/calibrate.mjs observations <observations.json> [options.json] [--json]
  node _workflow/calibrate.mjs prepare-observations <manual.json>
See _workflow/CALIBRATION.md for contracts. Unknown values must be explicit null.`;

export function main(args, io = { read: (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')), out: (s) => process.stdout.write(s + '\n') }) {
  if (!args.length || args[0] === '--help') { io.out(help); return; }
  const json = args.includes('--json');
  const positional = args.filter((a) => a !== '--json');
  const [command, ...paths] = positional;
  const counts = { freeze: [1], validate: [1], blind: [2], report: [3], observations: [1, 2], 'prepare-observations': [1] };
  if (!counts[command]?.includes(paths.length) || paths.some((p) => p.startsWith('--')) || args.filter((a) => a === '--json').length > 1) throw new TypeError(help);
  const values = paths.map(io.read);
  let result;
  if (command === 'freeze') result = freezeExperiment(values[0]);
  if (command === 'validate') { validateFrozenExperiment(values[0]); result = { valid: true, digest: values[0].digest }; }
  if (command === 'blind') result = blindPacket(...values);
  if (command === 'report') { result = reportExperiment(...values); if (!json) result = renderExperimentReport(result); }
  if (command === 'prepare-observations') {
    if (!Array.isArray(values[0])) throw new TypeError('manual observations must be an array');
    result = values[0].map((row) => {
      if (!['acceptance', 'finding', 'reuse'].includes(row?.kind)) throw new TypeError('manual input supports acceptance, finding and reuse only');
      return makeObservation(row);
    });
    const report = aggregateObservations(result);
    if (report.conflicts.length) throw new TypeError('conflicting manual identities: ' + JSON.stringify(report.conflicts));
  }
  if (command === 'observations') {
    if (!Array.isArray(values[0])) throw new TypeError('observations must be an array');
    result = aggregateObservations(values[0], values[1]);
    if (result.invalid.length || result.conflicts.length) throw new TypeError('invalid/conflicting observations: ' + JSON.stringify({ invalid: result.invalid, conflicts: result.conflicts }));
    if (!json) result = renderObservationReport(result);
  }
  io.out(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write('calibrate: ' + error.message + '\n'); process.exitCode = 1; }
}
