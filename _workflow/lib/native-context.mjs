import { nativeRequestJson, nativeRequestSha256 } from './native-evidence-request.mjs';
import { writeArtifactAtomic, readArtifactInput } from './native-artifact-guard.mjs';
import { join } from 'node:path';

const fields = ['acceptance', 'policies', 'profile', 'reviewerContract', 'inputs', 'engineMount'];

export function stageNativeContext(artifactDir, metadata) {
  const context = Object.fromEntries(fields.map(key => {
    if (!Object.hasOwn(metadata, key)) throw new Error('missing immutable native context: ' + key);
    return [key, metadata[key]];
  }));
  const bytes = nativeRequestJson(context), digest = nativeRequestSha256(bytes);
  const name = 'native-context-' + digest + '.json';
  writeArtifactAtomic(artifactDir, name, bytes, { immutable: true });
  return { version: 1, digest, path: join(artifactDir, name) };
}

export function hydrateNativeContext(artifactDir, input) {
  if (!Object.hasOwn(input, 'relayContext')) return input;
  const { relayContext, ...dynamic } = input;
  if (relayContext?.version !== 1 || !/^[0-9a-f]{64}$/.test(relayContext.digest || '') || fields.some(key => Object.hasOwn(dynamic, key)) || Object.hasOwn(dynamic, 'relayBriefs')) throw new Error('invalid immutable native context reference');
  const bytes = readArtifactInput(artifactDir, relayContext.path, 'native-context-' + relayContext.digest + '.json');
  if (nativeRequestSha256(bytes) !== relayContext.digest) throw new Error('native context digest mismatch');
  const context = JSON.parse(bytes);
  if (Object.keys(context).length !== fields.length || fields.some(key => !Object.hasOwn(context, key))) throw new Error('invalid immutable native context fields');
  return { ...context, ...dynamic };
}
