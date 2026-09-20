export function nativeCheckpointSnapshot(result) {
  const { tokensUsed, tokenAttributionConfidence, usage, attemptObservations, ...core } = result;
  if (attemptObservations) core.attemptObservations = attemptObservations.map(function (o) {
    return { version: o.version, runId: o.runId, itemId: o.itemId, attemptId: o.attemptId,
      dispatchId: o.dispatchId, stage: o.stage, phase: o.phase, runtimeVersion: o.runtimeVersion,
      requestedModel: o.requestedModel, effort: o.effort, retry: o.retry, fallback: o.fallback,
      overhead: o.overhead, outcome: 'started', attributionConfidence: 'unknown' };
  });
  return core;
}

export function nativeShellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

export function nativeJsonWriteInstruction(path, payloadReference) {
  return 'MANDATORY FILE TOOL ORDER: use the Read tool on ' + JSON.stringify(path) + ' FIRST, including on replay and every retry. The installed Write tool refuses to overwrite an existing file not yet read by this worker. If Read reports file-not-found, create it with the Write tool. If it exists and its bytes already equal ' + payloadReference + ', skip Write; otherwise use the Write tool to replace it with that EXACT engine-computed JSON, byte-for-byte, one line, no newline, reformatting, omitted fields or markdown fences. After either an exact-byte skip or successful Write, execute the prescribed helper/verification command. For a read-before-write error, Read that same path before retrying Write. If Read or Write is denied or otherwise fails, report tool failure. Never use shell filesystem writes, heredocs, redirects, Python or node -e write fallbacks.';
}

export function nativeSchemaValid(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && !types.includes(type)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (type === 'number' && !Number.isFinite(value)) return false;
  if (type === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (type === 'array' && schema.items && !value.every(v => nativeSchemaValid(v, schema.items))) return false;
  if (type === 'object') {
    if ((schema.required || []).some(k => !Object.prototype.hasOwnProperty.call(value, k))) return false;
    for (const k of Object.keys(value)) {
      const child = (schema.properties || {})[k];
      if (child ? !nativeSchemaValid(value[k], child) : schema.additionalProperties === false) return false;
    }
  }
  return true;
}
