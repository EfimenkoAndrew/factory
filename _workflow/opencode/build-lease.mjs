import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuildTest } from './buildtest.mjs';
import { withBuildSlot, leasedCommand } from '../lib/build-lease.mjs';
export { withBuildSlot, leasedCommand, buildCapacity } from '../lib/build-lease.mjs';

export function limitedBuildTest(root, sub, args, options) {
  return /^(build|red|filter|suite|efmigration)$/.test(sub) ? withBuildSlot(root, () => {
    const r = runBuildTest(root, sub, args, options);
    if (r.code < 0) { const error = new Error('build process timeout/unavailable; lease retained until process-tree inspection'); error.unsettled = true; throw error; }
    return r;
  }) : runBuildTest(root, sub, args, options);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, sub, ...args] = process.argv.slice(2);
    if (!root || !sub) throw new Error('usage: build-lease.mjs <factoryRoot> -- <command> [args] OR <factoryRoot> <build-test-subcommand> [args]');
    if (sub === '--') process.exitCode = leasedCommand(root, args[0], args.slice(1)).status;
    else { const r = limitedBuildTest(root, sub, args); process.stdout.write(r.output); process.exitCode = r.code < 0 ? 1 : r.code; }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
