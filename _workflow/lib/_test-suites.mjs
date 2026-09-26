export function selectTestSuite(args) {
  if (args.length === 0) return 'portable';
  if (args.length === 1 && args[0] === '--integration') return 'all';
  if (args.length === 2 && args[0] === '--suite' && ['portable', 'integration', 'all'].includes(args[1])) return args[1];
  throw new Error('Usage: node _workflow/lib/_selftest.mjs [--suite portable|integration|all] [or --integration (all)]');
}
