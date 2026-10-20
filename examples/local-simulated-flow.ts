/** 仅本地模拟：假节点、假远端任务，真实自造媒体。绝不连接供应商，也不是商用adapter。 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRunningHubBackend } from '../source/apps/web/lib/video/backends/runninghub';
import { createCandidateCollector, type StoredCandidate } from '../source/apps/web/lib/video/backend-runtime/collector';
import { assembleVideo, probeMedia } from '../source/apps/web/lib/video/media';
import type { RunningHubApplication } from '../source/apps/web/lib/video/backends/runninghub-protocol';

const execute = promisify(execFile);
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--run' || !/^[a-z0-9_-]{1,40}$/.test(args[1]))) throw new Error('use_--run_with_a_safe_test_name');
const root = path.resolve(args.length ? path.join('examples/local-runs', args[1]) : 'examples/generated');
const assets = path.join(root, 'assets');
const objects = path.join(root, 'objects');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const ffmpeg = process.env.VIDEO_FFMPEG_PATH || 'ffmpeg';
const journalPath = path.join(root, 'SIMULATED-journal.json');
const counters = { submit: 0, query: 0, download: 0 };
async function exists(file: string) { try { await readFile(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }

async function main() {
  await mkdir(assets, { recursive: true });
  await mkdir(objects, { recursive: true });
  // 只有几何颜色和合成正弦音，不读取用户图片、视频或声音。
  const motion = path.join(assets, 'SIMULATED-motion.mp4');
  const candidate = path.join(assets, 'SIMULATED-provider-candidate.mp4');
  const reference = path.join(assets, 'SIMULATED-reference.ppm');
  if (!await exists(motion)) await execute(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=144x256:r=10:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', motion], { windowsHide: true });
  if (!await exists(candidate)) await execute(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=144x256:r=10:d=4',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', candidate], { windowsHide: true });
  if (!await exists(reference)) {
    const pixels = Buffer.alloc(144 * 256 * 3);
    for (let offset = 0; offset < pixels.length; offset += 3) { pixels[offset] = 255; pixels[offset + 1] = 128; }
    await writeFile(reference, Buffer.concat([Buffer.from('P6\n144 256\n255\n'), pixels]));
  }
  const input = { mode: 'LOCAL_SIMULATION_ONLY', requirement: '用自造蓝色动作片和橙色参考图演示一次4秒视频阶段，再交给本地FFmpeg。',
    motion: { path: 'assets/SIMULATED-motion.mp4', sha256: hash(await readFile(motion)) },
    reference: { path: 'assets/SIMULATED-reference.ppm', sha256: hash(await readFile(reference)) }, duration: 4 };
  await writeFile(path.join(root, 'SIMULATED-input.json'), JSON.stringify(input, null, 2));
  // 以下所有ID和字段目标都是协议测试值，不能当作真实 RunningHub 应用配置。
  const application: RunningHubApplication = { accountId: 'fixture-account', webappId: '9000000000000000001', mappingVersion: 'fixture-v1',
    mappingEvidence: 'LOCAL_SYNTHETIC_NOT_REAL_WORKFLOW', bindings: [
      { inputKey: 'prompt', nodeId: '1', fieldName: 'text' }, { inputKey: 'motion', nodeId: '2', fieldName: 'video' },
      { inputKey: 'reference', nodeId: '3', fieldName: 'image' }, { inputKey: 'duration', nodeId: '4', fieldName: 'seconds' }] };
  const inputDigest = hash(JSON.stringify(input));
  let journal: { backendId: string; inputDigest: string; state: string; taskId?: string; receipt?: unknown } | null =
    await exists(journalPath) ? JSON.parse(await readFile(journalPath, 'utf8')) : null;
  const save = async () => { const handle = await open(journalPath, 'w'); try { await handle.writeFile(JSON.stringify(journal, null, 2)); await handle.sync(); } finally { await handle.close(); } };
  const backend = createRunningHubBackend({ apiKey: 'fixture-not-a-real-credential', application, warn: () => {},
    gate: { async claim(intent) {
      if (journal) return 'already_claimed';
      const handle = await open(journalPath, 'wx');
      journal = { backendId: intent.attempt.backendId, inputDigest, state: 'submitting' };
      try { await handle.writeFile(JSON.stringify(journal, null, 2)); await handle.sync(); } finally { await handle.close(); }
      return 'claimed';
    } },
    transport: async request => {
      const body = JSON.parse(request.body);
      if (request.url.endsWith('/ai-app/run')) { counters.submit++; assert.equal(body.webappId, application.webappId);
        return { status: 200, body: JSON.stringify({ code: 0, data: { taskId: '9000000000000000002' } }) }; }
      counters.query++; assert.equal(body.taskId, '9000000000000000002');
      return { status: 200, body: JSON.stringify({ code: 0, data: [{ fileUrl: 'https://media.example.test/SIMULATED-candidate.mp4', fileType: 'mp4' }] }) };
    } });
  if (journal) {
    assert.equal(journal.backendId, backend.backendId);
    assert.equal(journal.inputDigest, inputDigest);
    if (!journal.taskId) throw new Error('submission_unknown_no_task_id_no_resubmit');
  } else {
    const result = await backend.submit({ intent: { intentId: 'fixture-intent', fencingToken: 1, attempt: {
      backendId: backend.backendId, userId: 'fixture-user', runId: 'fixture-run', jobId: 'fixture-job', stepKey: 'fixture-stage',
      inputDigest, attemptId: 'fixture-attempt' } }, values: { prompt: input.requirement, motion: 'FIXTURE_UPLOAD_MOTION', reference: 'FIXTURE_UPLOAD_REFERENCE', duration: '4' } });
    assert.equal(result.kind, 'accepted');
    if (result.kind !== 'accepted') throw new Error('fixture_submit_failed');
    journal = { backendId: backend.backendId, inputDigest, state: 'accepted', taskId: result.taskId };
    await save();
  }
  const result = await backend.results({ backendId: journal.backendId, taskId: journal.taskId! });
  if (result.kind !== 'completed') throw new Error('fixture_query_failed');
  const collector = createCandidateCollector({ policy: { allowedHosts: ['media.example.test'], allowAddress: address => address === '203.0.113.7',
    maxBytes: 2 * 1024 * 1024, timeoutMs: 10000, durationToleranceSeconds: 0.15 },
    transport: { async resolveAddresses() { return ['203.0.113.7']; }, async request() { counters.download++;
      return { status: 200, body: (async function* () { yield await readFile(candidate); })() }; } },
    storage: { async putIfAbsent(key, object) {
      const target = path.join(objects, hash(key) + '.json');
      let handle; try { handle = await open(target, 'wx'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'; throw error; }
      try { await handle.writeFile(JSON.stringify({ bytes: Buffer.from(object.bytes).toString('base64'), receipt: object.receipt })); await handle.sync(); }
      finally { await handle.close(); }
      return 'created';
    }, async read(key) {
      const target = path.join(objects, hash(key) + '.json');
      if (!await exists(target)) return null;
      const stored = JSON.parse(await readFile(target, 'utf8'));
      return { bytes: Buffer.from(stored.bytes, 'base64'), receipt: stored.receipt } as StoredCandidate;
    } },
    media: { async inspect(bytes) { const file = path.join(root, 'SIMULATED-probe.mp4'); await writeFile(file, bytes); return probeMedia(file); } } });
  const identity = { userId: 'fixture-user', jobId: 'fixture-job', segmentIndex: 0, attempt: 1, inputDigest,
    requestedDuration: 4, width: 144, height: 256 };
  const receipt = await collector.recover(identity) ?? await collector.collect(identity, result.outputs[0].downloadUrl);
  journal.receipt = receipt; journal.state = 'collected'; await save();
  const receiptObject = JSON.parse(await readFile(path.join(objects, hash(receipt.key) + '.json'), 'utf8'));
  const nextStage = path.join(root, 'SIMULATED-next-stage-input.mp4');
  await writeFile(nextStage, Buffer.from(receiptObject.bytes, 'base64'));
  // 交接展示保留原合成函数。接收方应将这一职责交给已有FFmpeg服务。
  const assembled = await assembleVideo({ candidates: [nextStage], segments: [{ index: 0, start: 0, duration: 4, trimStart: 0 }],
    source: motion, duration: 4, preserveAudio: true, workspace: root });
  const final = path.join(root, 'SIMULATED-final.mp4');
  await writeFile(final, await readFile(assembled));
  const report = { classification: 'LOCAL_SIMULATION_NOT_PROVIDER_RESULT', networkRequests: 0, counters, receipt,
    nextStageInput: 'SIMULATED-next-stage-input.mp4', final: 'SIMULATED-final.mp4', finalSha256: hash(await readFile(final)),
    media: await probeMedia(final), productionGate: false, applicationMappingReal: false,
    limitation: '本例为串行文件记录示范；不是并发/跨进程事务或生产adapter。真实工作流JSON、节点/上传映射和权限仍缺失。' };
  await writeFile(path.join(root, 'SIMULATED-run-latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ classification: report.classification, counters, final: path.relative(process.cwd(), final).split(path.sep).join('/'), media: report.media }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'local_simulation_failed'); process.exitCode = 1; });
