import { responseContract } from './live-benchmark.mjs';

export function heldoutCases() {
  const defs = [
    ['H01', 'documentation', 'approved', 'Document production retry count only; the development example must be explicitly labeled and may differ.', {
      'config.json': '{"productionRetries":3}', 'README.md': 'Production retries: 3. Development example (not production): retries=9.\n',
    }, []],
    ['H02', 'documentation', 'rejected', 'Document that enabling audit does not enable export; list the actual default for both flags.', {
      'config.json': '{"audit":true,"export":false}', 'README.md': 'Audit defaults to enabled. Export defaults to enabled whenever audit is enabled.\n',
    }, ['documentation:README.md']],
    ['H03', 'documentation', 'approved', 'The route index must list public routes only. Internal /admin/metrics must not appear in the public index.', {
      'routes.json': '[{"path":"/health","public":true},{"path":"/orders","public":true},{"path":"/admin/metrics","public":false}]',
      'README.md': 'Public routes: /health, /orders.\n',
    }, []],
    ['H04', 'documentation', 'mixed', 'Document maxBatch and state explicitly that timeoutMs is milliseconds, not seconds.', {
      'config.json': '{"maxBatch":50,"timeoutMs":2000}', 'README.md': 'Maximum batch size: 50. Timeout: 2000 seconds.\n',
    }, ['documentation:README.md']],
    ['H05', 'ordinary-code', 'approved', 'Inputs are finite numbers with min<=max. Clamp inclusively. No validation for nonfinite or reversed bounds is required.', {
      'clamp.js': 'export function clamp(x,min,max) {\n  return Math.max(min,Math.min(max,x));\n}\n',
    }, []],
    ['H06', 'ordinary-code', 'rejected', 'For arrays of numbers return the largest value, or null for an empty array. Negative numbers are valid.', {
      'largest.js': 'export function largest(values) {\n  if (!values.length) return null;\n  return values.reduce((max,x)=>Math.max(max,x),0);\n}\n',
    }, ['bounds:largest.js']],
    ['H07', 'ordinary-code', 'approved', 'Return the last size rows, or [] when size is zero. size is an integer 0..rows.length; never mutate rows.', {
      'tail.js': 'export function tail(rows,size) {\n  if (size===0) return [];\n  return rows.slice(-size);\n}\n',
    }, []],
    ['H08', 'ordinary-code', 'mixed', 'Given a nonnegative integer retry count, invoke send at most count+1 times, stop after first success, and throw the final error if all calls fail. send is synchronous and returns any value on success.', {
      'retry.js': 'export function retry(send,count) {\n  let last;\n  for(let i=0;i<count;i++) {\n    try { return send(); } catch(error) { last=error; }\n  }\n  throw last;\n}\n',
    }, ['bounds:retry.js']],
    ['H09', 'high-risk', 'approved', 'Return order with matching id only within authenticated context tenant. rows and tenantId/id are valid; order ids can repeat across tenants. Undefined if absent.', {
      'lookup.js': 'export function lookup(rows,id,context) {\n  const tenantRows=rows.filter(r=>r.tenantId===context.tenantId);\n  return tenantRows.find(r=>r.id===id);\n}\n',
    }, []],
    ['H10', 'high-risk', 'mixed', 'If a non-null row belongs to context.tenantId return it; if null or any different tenant return null. tenant IDs are nonempty strings. No global/admin exception exists.', {
      'authorize.js': 'export function authorize(row,context) {\n  if (!row) return null;\n  if (row.tenantId!==context.tenantId && row.tenantId!=="public") return null;\n  return row;\n}\n',
    }, ['tenant:authorize.js']],
    ['H11', 'high-risk', 'approved', 'Sequential deliveries: credit once per immutable event id and do not log secret values. State is in-memory for this process; operations never throw, restart persistence and concurrency are out of scope. Inputs and amount are valid.', {
      'credit.js': 'export function credit(state,event,log) {\n  if(state.seen.has(event.id)) return;\n  state.seen.add(event.id);\n  state.balance+=event.amount;\n  log({id:event.id,secret:"[REDACTED]"});\n}\n',
    }, []],
    ['H12', 'high-risk', 'mixed', 'Sequential deliveries must credit each id once, including retries after credit throws before making any change. credit succeeds on a later retry. Do not log the event secret. state.seen is a Set; all operations except credit succeed.', {
      'deliver.js': 'export function deliver(state,event,credit,log) {\n  if(state.seen.has(event.id)) return;\n  state.seen.add(event.id);\n  credit(event.amount);\n  log({id:event.id,secret:"[REDACTED]"});\n}\n',
    }, ['idempotency:deliver.js']],
  ];
  return defs.map(([caseId,stratum,originalOutcome,acceptance,files,seeds])=>({caseId,itemId:'heldout-'+caseId,stratum,originalOutcome,
    snapshot:{baseRevision:'synthetic-heldout-v1',acceptance,files,policy:{noExternalAssumptions:true},reviewerContract:responseContract.replace('all six cases','all supplied cases')},seeds}));
}
