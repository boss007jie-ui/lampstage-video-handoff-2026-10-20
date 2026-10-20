import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRunningHubSubmission, parseRunningHubOutputs } from '../source/apps/web/lib/video/backends/runninghub-protocol';
import { createRunningHubBackend } from '../source/apps/web/lib/video/backends/runninghub';
import { cancelVideoTask } from '../source/apps/web/lib/video/backends/contracts';
import { buildNano21Request } from '../source/apps/web/lib/providers/image-requests';

async function main() {
  const fixture = JSON.parse(await readFile('fixtures/protocol-cases.json', 'utf8'));
  for (const entry of fixture.cases) {
    const actual = entry.parser === 'submit' ? parseRunningHubSubmission(entry.response) : parseRunningHubOutputs(entry.response);
    assert.deepEqual(actual, entry.expected, entry.name);
  }
  const image = buildNano21Request('fixture stage prompt', [{ bytes: Buffer.from('fixture-frame'), mime: 'image/png' }, { bytes: Buffer.from('fixture-product'), mime: 'image/png' }]);
  assert.deepEqual(image.generationConfig, { responseModalities: ['TEXT', 'IMAGE'] });
  assert.equal(image.contents[0].parts.length, 3);
  assert.equal((image.contents[0].parts[1] as { inlineData: { data: string } }).inlineData.data, Buffer.from('fixture-frame').toString('base64'));
  const backend = createRunningHubBackend({ apiKey: 'fixture-non-secret', timeoutMs: 5, warn: () => {},
    application: { accountId: 'fixture-account', webappId: '9000000000000000001', mappingVersion: 'fixture-v1', mappingEvidence: 'LOCAL_TEST_ONLY',
      bindings: [{ inputKey: 'prompt', nodeId: '1', fieldName: 'text' }] }, gate: { async claim() { return 'claimed'; } }, transport: async () => new Promise(() => {}) });
  assert.deepEqual(await cancelVideoTask(backend, { backendId: backend.backendId, taskId: '9000000000000000002' }), { kind: 'unsupported', code: 'cancel_unsupported' });
  const timeout = await backend.submit({ intent: { intentId: 'fixture-intent', fencingToken: 1, attempt: { backendId: backend.backendId, userId: 'fixture-user',
    runId: 'fixture-run', jobId: 'fixture-job', stepKey: 'fixture-stage', inputDigest: 'fixture-digest', attemptId: 'fixture-attempt' } }, values: { prompt: 'fixture' } });
  assert.deepEqual(timeout, { kind: 'submission_unknown', code: 'submission_transport_unknown' });
  console.log(JSON.stringify({ fixtureCasesPassed: fixture.cases.length, additionalScenarioChecks: 3, networkCalls: 0, realApplicationMapping: false }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'contract_samples_failed'); process.exitCode = 1; });
