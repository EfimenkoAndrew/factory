#!/usr/bin/env node
import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateTrx } from './lib/test-results.mjs';

const [directory, sub, rawCode] = process.argv.slice(2);
let code = /^\d+$/.test(rawCode || '') ? Number(rawCode) : 2;
try {
  if (!directory || !['filter', 'suite'].includes(sub) || !Number.isSafeInteger(code)) throw new Error('usage: test-results.mjs <results-directory> <filter|suite> <dotnet-exit>');
  const documents = [];
  let bytes = 0, entries = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 8) throw new Error('TRX directory nesting limit');
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 10000) throw new Error('TRX directory entry limit');
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('TRX symbolic links refused');
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (/\.trx$/i.test(entry.name)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024) throw new Error('TRX file size/type limit');
        const buffer = readFileSync(path);
        const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le'
          : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : 'utf-8';
        documents.push(new TextDecoder(encoding, { fatal: true }).decode(buffer));
      }
    }
  };
  walk(directory);
  const results = aggregateTrx(documents, code);
  for (const failure of results.failures) console.log('FACTORY::TEST::FAILURE ' + JSON.stringify(failure));
  console.log(`FACTORY::SUMMARY::${sub} exit=${code} failed=${results.failed} passed=${results.passed} skipped=${results.skipped} total=${results.total}`);
} catch (error) {
  console.log('FACTORY::TEST::DIAGNOSTIC ' + JSON.stringify({ status: 'unavailable', reason: error.message, commandExit: code }));
  // Exit 2 cannot be mistaken for an ordinary, baseline-eligible test failure.
  if (code === 0 || code === 1) code = 2;
  if (['filter', 'suite'].includes(sub)) console.log(`FACTORY::SUMMARY::${sub} exit=${code} failed=-1 passed=-1 skipped=-1 total=-1`);
}
process.exitCode = code;
