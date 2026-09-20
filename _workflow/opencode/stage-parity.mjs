export const MECHANICAL = {
  'progress-writer': 'saveProgress and checkpoint use the shared atomic Node writer under the item lock; no model relay is required.',
  runner: 'executeVerification enforces subprocess completion, target/filter START identity, keyed SUMMARY, nonvacuous counts and explicit suite baseline; finalBarrier refreshes independent evidence before final reviews.',
  'marker-probe': 'afterVerify and finalBarrier read the real-infrastructure marker; a reasoned override requires independent realinfra_adjudicate and persists original/effective classification.',
  'comment-probe': 'runCommentGate uses the shared deterministic scanner under the snapshotted host policy; unavailable enabled scans fail explicitly.',
  'red-proof-probe': 'afterVerify/finalBarrier require disk RED proof with the verification-only polarity inversion; missing evidence fails before gates.',
  'rootcause-probe': 'afterVerify/finalBarrier derive actual changed files and enforce non-test root-cause changes plus debris checks.',
  'evidence-identity': 'identity.snapshotTree fingerprints HEAD, complete tracked/untracked content, modes, acceptance and snapshotted contracts; persisted dispatches and pending-only resume reuse the unaffected prefix.',
  'efmigration-probe': 'native-checks.efProbe invokes the real build-test.sh efmigration command for touched service layouts; dirty fails before gates and inconclusive results are explicitly recorded.',
  'main-drift-probe': 'native-checks.mainDrift reads the claim-time main snapshot and shared drift/status derivation without invoking repair or mutating git; finalBarrier honors failLaneOnMainDrift.',
};

export const UNPORTED = {};
export const STAGE_PARITY = { mechanical: MECHANICAL, unported: UNPORTED };
export const SHARED_CONSTANTS = ['REALINFRA_SIGNAL', 'BAND_FULL_THEMES'];
