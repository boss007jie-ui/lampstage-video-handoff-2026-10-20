import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertVideoPaidGenerationEnabled } from './control';

export const H3_PROVIDER = 'hypit-provider-runninghub-product-v6';
export const SIXREF_PROVIDER = 'hypit-provider-runninghub-sixref';
export const H3_CAPABILITY = '@hypit/minimax-h3@1#minimax-h3';
export const H3_ENDPOINT = 'runninghub.account01';
const cliCandidates = process.platform === 'win32'
  ? [path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm/node_modules/@hypit/hypit/bin/hypit.mjs')]
  : ['/usr/local/lib/node_modules/@hypit/hypit/bin/hypit.mjs', '/usr/lib/node_modules/@hypit/hypit/bin/hypit.mjs', path.join(os.homedir(), '.npm-global/lib/node_modules/@hypit/hypit/bin/hypit.mjs')];
export const DEFAULT_HYPIT_CLI = cliCandidates.find(candidate => existsSync(candidate)) ?? cliCandidates[0];
const vendorCandidates = [path.resolve('vendor/hypit'), path.resolve('apps/web/vendor/hypit')];
export const DEFAULT_HYPIT_PACKAGE_ROOT = vendorCandidates.find(candidate => existsSync(path.join(candidate, 'packages', H3_PROVIDER, 'package.json'))) ?? vendorCandidates[0];
const OUTPUT = 'result.video';
const MAX_JSON = 2 * 1024 * 1024;
// External CLI/config JSON has command-dependent shapes. Every used field is checked at its boundary;
// this alias is confined to transport parsing rather than exported domain types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
export type CliProcess = (cli: string, args: string[], cwd: string, timeout: number) => Promise<Json>;

/** Deliberately never includes child stderr, stdout, environment, or provider error bodies. */
export class HypitProcessError extends Error {
  constructor() { super('Hypit command failed or returned an invalid response.'); }
}
export class SubmissionUnknownError extends Error {
  readonly code = 'VIDEO_SUBMISSION_UNKNOWN';
  constructor(readonly buildId?: string) {
    super('Video submission may have been accepted. Reconcile the existing attempt before retrying.');
  }
}

export const runHypitProcess: CliProcess = (cli, args, cwd, timeout) => new Promise((resolve, reject) => {
  execFile(process.execPath, [cli, ...args, '--json', '--color', 'never'], {
    cwd, shell: false, windowsHide: true, timeout, maxBuffer: MAX_JSON, encoding: 'utf8',
  }, (error, stdout) => {
    try {
      const value = JSON.parse(stdout);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      // status 用正常退出码 1 表达已失败的结果；只有严格绑定的上游终态证明可穿过此边界。
      // 超时、信号、其他退出码以及 build 等命令仍按执行失败处理，绝不推断提交成功。
      if (error && !(error.code === 1 && !error.killed && !error.signal && args[0] === 'status' && safeId(args[1]) &&
        value.format === 'hypit.cli-status@1' && value.build?.id === args[1] &&
        value.build.work?.state === 'done' && value.build.work?.outcome === 'failed' && value.build.result?.state === 'failed' &&
        terminalFailureReceipt(value.build))) throw new Error();
      resolve(value);
    } catch { reject(new HypitProcessError()); }
  });
});

export function escapeXml(value: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error('Unsupported control character in video input.');
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function inside(root: string, file: string) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,200}$/.test(value); }
function terminalFailureReceipt(build: Json): string | undefined {
  const operations = build.operations;
  if (!Array.isArray(operations) || operations.length !== 1) return undefined;
  const operation = operations[0];
  return operation?.endpoint === H3_ENDPOINT && operation.state === 'failed' && safeId(operation.receipt?.id) &&
    operation.failure?.code === 'RUNNINGHUB_TERMINAL_FAILURE' ? operation.receipt.id : undefined;
}
async function jsonFile(file: string): Promise<Json> { return JSON.parse(await readFile(file, 'utf8')); }
function receiptPath(workspace: string) { return path.join(workspace, 'hypit-build-receipt.json'); }
export async function readLocalBuildReceipt(workspace: string): Promise<{ buildId: string } | null> {
  try { const value = await jsonFile(receiptPath(workspace)); return safeId(value.buildId) ? { buildId: value.buildId } : null; }
  catch { return null; }
}

export function createHypitRunner(options: { env?: NodeJS.ProcessEnv; process?: CliProcess; route?: 'legacy' | 'sixref-v1' } = {}) {
  const env = options.env ?? process.env;
  const execute = options.process ?? runHypitProcess;
  const route = options.route ?? 'legacy';
  const provider = route === 'sixref-v1' ? SIXREF_PROVIDER : H3_PROVIDER;
  async function configuration() {
    const runtimeSetting = route === 'sixref-v1' ? env.VIDEO_SIXREF_HYPIT_RUNTIME : env.VIDEO_HYPIT_RUNTIME;
    if (!runtimeSetting) throw new Error(`${route === 'sixref-v1' ? 'VIDEO_SIXREF_HYPIT_RUNTIME' : 'VIDEO_HYPIT_RUNTIME'} is not configured.`);
    const runtime = path.resolve(runtimeSetting);
    const profile = await jsonFile(runtime);
    const account = await jsonFile(`${runtime}.account.json`);
    const endpoint = profile.endpoints?.[H3_ENDPOINT];
    const ref = endpoint?.config?.apiKey;
    if (account.account !== '01' || account.endpoint !== H3_ENDPOINT ||
      profile.format !== 'hypit.runtime-local@1' || profile.bindings?.[H3_CAPABILITY] !== H3_ENDPOINT ||
      endpoint?.use !== provider || endpoint.config.baseUrl !== 'https://www.runninghub.cn' ||
      typeof ref?.store !== 'string' || typeof ref?.key !== 'string' ||
      ref.store !== account.credential?.store || ref.key !== account.credential?.key ||
      /(?:^|[_ .-])0?2$/u.test(ref.key) || Object.keys(profile.endpoints).length !== 1) {
      throw new Error('An isolated H3 account 01 runtime is required.');
    }
    const store = profile.credentials?.[ref.store];
    if (!['@hypit/credential-store-platform', '@hypit/credential-store-os', '@hypit/credential-store-env'].includes(store?.use))
      throw new Error('Unsupported account 01 credential store.');
    if (store.use === '@hypit/credential-store-env' && ref.key !== 'RUNNINGHUB_API_KEY_01')
      throw new Error('The environment credential must be RUNNINGHUB_API_KEY_01.');
    // Reconstruct only the supported nonsecret configuration; never copy arbitrary configuration.
    const cleanProfile = {
      format: 'hypit.runtime-local@1', dataRoot: './.hypit/execution',
      credentials: { [ref.store]: { use: store.use, ...(typeof store.config?.service === 'string' ? { config: { service: store.config.service } } : {}) } },
      endpoints: { [H3_ENDPOINT]: { use: provider, pool: 'runninghub.account01', config: {
        baseUrl: 'https://www.runninghub.cn', apiKey: { store: ref.store, key: ref.key },
        pollIntervalMs: 5000, timeoutMs: 1800000, instanceType: route === 'sixref-v1' ? 'default' : 'ultra',
        ...(route === 'sixref-v1' ? { firstPassMegapixels: 0.4096, upscaleFactor: 1.5 } : {}),
      } } }, bindings: { [H3_CAPABILITY]: H3_ENDPOINT },
    };
    const cli = env.VIDEO_HYPIT_CLI || DEFAULT_HYPIT_CLI;
    const packageRoot = env.VIDEO_HYPIT_PACKAGE_ROOT || (typeof account.packageRoot === 'string' ? path.resolve(path.dirname(runtime), account.packageRoot) : DEFAULT_HYPIT_PACKAGE_ROOT);
    await access(cli);
    await access(path.join(packageRoot, 'packages', provider, 'package.json'));
    return { runtime, profile: cleanProfile, cli, packageRoot };
  }
  function routeMatches(record: Json) {
    return route === 'legacy'
      ? (record.route === undefined || record.route === 'legacy') && (record.provider === undefined || record.provider === H3_PROVIDER)
      : record.route === 'sixref-v1' && record.provider === SIXREF_PROVIDER;
  }
  async function jobRuntimeMatches(workspace: string, expected: Json) {
    const profile = await jsonFile(path.join(workspace, 'hypit.runtime.json'));
    const endpoint = profile.endpoints?.[H3_ENDPOINT];
    return profile.format === 'hypit.runtime-local@1' && profile.dataRoot === './.hypit/execution' &&
      Object.keys(profile.endpoints ?? {}).length === 1 && endpoint?.use === provider &&
      profile.bindings?.[H3_CAPABILITY] === H3_ENDPOINT &&
      JSON.stringify(endpoint.config) === JSON.stringify(expected.endpoints[H3_ENDPOINT].config) &&
      JSON.stringify(profile.credentials) === JSON.stringify(expected.credentials);
  }
  async function runnerReadiness(): Promise<{ ready: boolean; reason?: string }> {
    try {
      const cfg = await configuration();
      const result = await execute(cfg.cli, ['auth', 'status', H3_ENDPOINT, '--runtime', cfg.runtime, '--workspace', cfg.packageRoot], cfg.packageRoot, 30000);
      const slots = result.credentials;
      if (result.format !== 'hypit.cli-auth-status@1' || result.endpoint !== H3_ENDPOINT || !Array.isArray(slots) ||
        !slots.some((slot: Json) => slot.endpoint === H3_ENDPOINT && slot.slot === 'apiKey' && slot.configured === true))
        return { ready: false, reason: 'RunningHub account 01 credential is not configured.' };
      return { ready: true };
    } catch { return { ready: false, reason: 'RunningHub account 01 runtime or credential is unavailable. Configure the isolated video runtime.' }; }
  }
  async function submitH3(input: {
    workspace: string; sourcePath: string;
    prompt: string; duration: 4 | 5 | 6 | 8; onBuildId: (id: string) => Promise<void>;
    /**
     * 付费提交前的最后一道闸门：读**当前数据库状态**核对开关、租约、revision 与已保存的
     * renderConsent。放在 intent 落库之前——一旦写了 intent 就进入"意图已持久化"的模糊区，
     * 那时再拒绝会把任务卡进人工核对。
     */
    beforeSubmit?: () => Promise<void>;
  } & (
    { productPath: string; openingPath: string; endingPath: string; referencePaths?: never } |
    { referencePaths: readonly string[]; productPath?: never; openingPath?: never; endingPath?: never }
  )): Promise<{ buildId: string }> {
    if (!(route === 'sixref-v1' ? [4, 5, 6, 8].includes(input.duration) : [4, 5].includes(input.duration)))
      throw new Error(route === 'sixref-v1' ? 'H3 requires a 4, 5, 6 or 8 second source window.' : 'H3 requires a 4 or 5 second source window.');
    if (!input.prompt.trim() || input.prompt.length > 20000) throw new Error('Invalid H3 prompt.');
    const direct = 'referencePaths' in input;
    if (direct && ('productPath' in input || 'openingPath' in input || 'endingPath' in input))
      throw new Error('H3 input cannot mix direct and legacy references.');
    const references = direct ? input.referencePaths : [input.productPath, input.openingPath, input.endingPath];
    if (route === 'sixref-v1' && !direct) throw new Error('Six-reference H3 requires direct reference paths.');
    if (!Array.isArray(references) || (route === 'sixref-v1' ? references.length < 1 || references.length > 6 : references.length !== 3) ||
      references.some(file => typeof file !== 'string' || !file.trim()))
      throw new Error(route === 'sixref-v1' ? 'H3 requires one to six nonempty image paths.' : 'H3 requires exactly three nonempty image paths.');
    // 快速失败：付费开关关闭时连本地 check/plan 都不做，绝不触碰 build。
    // 用 runner 自己的 env，避免模拟测试误读生产环境。
    assertVideoPaidGenerationEnabled(env);
    const cfg = await configuration();
    const ready = await runnerReadiness();
    if (!ready.ready) throw new Error(ready.reason);
    await mkdir(input.workspace, { recursive: true });
    const workspace = await realpath(input.workspace);
    // Every asset is admitted from the job workspace, including after symlink resolution.
    const paths = await Promise.all([...references, input.sourcePath].map(async file => {
      const actual = await realpath(file);
      if (!inside(workspace, actual)) throw new Error('Video inputs must belong to the job workspace.');
      return `./${path.relative(workspace, actual).split(path.sep).join('/')}`;
    }));
    const runtime = path.join(workspace, 'hypit.runtime.json');
    const source = path.join(workspace, 'video.svml');
    const run = path.join(workspace, 'video.svrun');
    const authored = `<?svml using="@hypit/markup@1"?>\n<svml>\n<import as="asset" from="@hypit/media@1"/>\n<import as="text" from="@hypit/text@1"/>\n<import as="h3" from="@hypit/minimax-h3@1"/>\n${paths.slice(0, references.length).map((file, i) => `<asset:Image id="image${i}" src="${escapeXml(file)}"/>`).join('\n')}\n<asset:Video id="motion" src="${escapeXml(paths[references.length])}"/>\n<text:Value id="direction">${escapeXml(input.prompt)}</text:Value>\n<h3:ReferenceVideo id="result" prompt={direction} duration="${input.duration}" resolution="768P" aspect-ratio="9:16">\n${references.map((_file, i) => `<h3:Reference image={image${i}}/>`).join('')}<h3:Reference video={motion}/>\n</h3:ReferenceVideo>\n</svml>\n`;
    // Exclusive writes make re-entry fail closed before the paid submission boundary.
    await writeFile(runtime, JSON.stringify(cfg.profile, null, 2), { flag: 'wx' });
    await writeFile(source, authored, { flag: 'wx' });
    await writeFile(run, `<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"><author source="./video.svml"/><target output="${OUTPUT}"/></svrun>\n`, { flag: 'wx' });
    const common = ['--workspace', workspace, '--package-root', cfg.packageRoot];
    const check = await execute(cfg.cli, ['check', run, ...common], workspace, 60000);
    if (check.format !== 'hypit.cli-check@1' || check.ok !== true) throw new Error('H3 source validation failed.');
    const plan = await execute(cfg.cli, ['plan', run, '--runtime', runtime, ...common], workspace, 60000);
    if (plan.format !== 'hypit.cli-plan@1' || plan.ok !== true || plan.requestCount !== 1 || plan.requestIssueCount !== 0 ||
      plan.preflight?.ok !== true || !Array.isArray(plan.providers) || plan.providers.length !== 1 ||
      plan.providers[0].endpoint !== H3_ENDPOINT || plan.providers[0].use !== provider || plan.providers[0].status !== 'resolved')
      throw new Error('H3 preflight did not resolve exactly one account 01 video request.');
    await input.beforeSubmit?.();
    await writeFile(path.join(workspace, 'hypit-submission-intent.json'), JSON.stringify({ account: '01', route, provider, output: OUTPUT, createdAt: new Date().toISOString() }), { flag: 'wx' });
    let buildId: string | undefined;
    try {
      const submitted = await execute(cfg.cli, ['build', run, '--runtime', runtime, ...common, '--max-wait-ms', '60000'], workspace, 90000);
      if (submitted.format !== 'hypit.cli-build@1' || !safeId(submitted.build?.id)) throw new SubmissionUnknownError();
      buildId = submitted.build.id;
      await writeFile(receiptPath(workspace), JSON.stringify({ buildId, route, provider, output: OUTPUT }), { flag: 'wx' });
      await input.onBuildId(buildId!);
      return { buildId: buildId! };
    } catch { throw new SubmissionUnknownError(buildId); }
  }
  async function inspectH3(input: { workspace: string; buildId: string }): Promise<{ state: 'working' | 'completed' | 'failed' | 'unknown'; taskId?: string; error?: string }> {
    if (!safeId(input.buildId)) throw new Error('Invalid build ID.');
    try {
      const cfg = await configuration();
      if (route === 'sixref-v1') {
        if (!await jobRuntimeMatches(input.workspace, cfg.profile)) return { state: 'unknown' };
        const localReceipt = await jsonFile(receiptPath(input.workspace)).catch(() => null);
        if (localReceipt && (!routeMatches(localReceipt) || localReceipt.buildId !== input.buildId)) return { state: 'unknown' };
        if (!localReceipt && !routeMatches(await jsonFile(path.join(input.workspace, 'hypit-submission-intent.json')))) return { state: 'unknown' };
      } else {
        const localReceipt = await jsonFile(receiptPath(input.workspace)).catch(() => null);
        if (localReceipt && !routeMatches(localReceipt)) return { state: 'unknown' };
        const jobProfile = await jsonFile(path.join(input.workspace, 'hypit.runtime.json')).catch(() => null);
        if (jobProfile && jobProfile.endpoints?.[H3_ENDPOINT]?.use !== provider) return { state: 'unknown' };
      }
      const status = await execute(cfg.cli, ['status', input.buildId, '--workspace', input.workspace, '--runtime', path.join(input.workspace, 'hypit.runtime.json'), '--verbose'], input.workspace, 30000);
      if (status.format !== 'hypit.cli-status@1' || !status.build || status.build.id !== input.buildId) return { state: 'unknown' };
      const build = status.build;
      const receipt = build.operations?.find((item: Json) => item.endpoint === H3_ENDPOINT && safeId(item.receipt?.id))?.receipt?.id;
      const details = receipt ? { taskId: receipt } : {};
      const failedReceipt = route === 'sixref-v1' ? terminalFailureReceipt(build) : undefined;
      // 操作级终态证明优先于尚未更新的 working 摘要；供应商原始错误文本不对外暴露。
      if (failedReceipt && failedReceipt === receipt) return { state: 'failed', error: 'RunningHub confirmed this task failed.', ...details };
      if (build.result?.state === 'complete' && build.work?.outcome === 'complete') return { state: 'completed', ...details };
      if (['failed', 'cancelled'].includes(build.work?.outcome) || ['failed', 'cancelled'].includes(build.result?.state)) {
        return { state: 'unknown', error: 'The local build stopped without proof of a terminal RunningHub result.', ...details };
      }
      if (['submitting', 'working'].includes(build.work?.state)) return { state: 'working', ...details };
      return { state: 'unknown', ...details };
    } catch { return { state: 'unknown', error: 'Unable to query the existing H3 build.' }; }
  }
  async function recoverH3Submission(workspace: string): Promise<{ buildId: string } | null> {
    const known = await readLocalBuildReceipt(workspace);
    if (known) {
      const value = await jsonFile(receiptPath(workspace)).catch(() => null);
      if (!value || !routeMatches(value)) return null;
      if (route === 'legacy') return known;
      const cfg = await configuration().catch(() => null);
      return cfg && await jobRuntimeMatches(workspace, cfg.profile).catch(() => false) ? known : null;
    }
    try {
      const intent = await jsonFile(path.join(workspace, 'hypit-submission-intent.json'));
      if (intent.account !== '01' || intent.output !== OUTPUT || !routeMatches(intent)) return null;
      const cfg = await configuration();
      if (route === 'sixref-v1' && !await jobRuntimeMatches(workspace, cfg.profile)) return null;
      // Public ledger views cover active work and completed Results without re-submission.
      const views = await Promise.all([
        execute(cfg.cli, ['activity', '--workspace', workspace, '--runtime', path.join(workspace, 'hypit.runtime.json'), '--verbose'], workspace, 30000),
        execute(cfg.cli, ['builds', '--workspace', workspace, '--limit', '100', '--verbose'], workspace, 30000),
      ]);
      if (views[0].format !== 'hypit.cli-activity@1' || views[1].format !== 'hypit.cli-builds@1' || views[1].next) return null;
      const active = Array.isArray(views[0].builds) ? views[0].builds : [];
      const results = Array.isArray(views[1].builds) ? views[1].builds : [];
      if (results.some((entry: Json) => entry.run !== 'video.svrun' || entry.targetCount !== 1 || entry.targets?.[0] !== OUTPUT)) return null;
      const ids = [...new Set([...active, ...results].map((entry: Json) => entry.id).filter(safeId))];
      if (ids.length !== 1) return null;
      const buildId = ids[0];
      const status = await execute(cfg.cli, ['status', buildId, '--workspace', workspace, '--runtime', path.join(workspace, 'hypit.runtime.json')], workspace, 30000);
      if (status.format !== 'hypit.cli-status@1' || status.build?.id !== buildId || status.build.targets?.length !== 1 || status.build.targets[0] !== OUTPUT) return null;
      try { await writeFile(receiptPath(workspace), JSON.stringify({ buildId, route, provider, output: OUTPUT, recovered: true }), { flag: 'wx' }); }
      catch { const concurrent = await readLocalBuildReceipt(workspace); if (concurrent?.buildId !== buildId || !routeMatches(await jsonFile(receiptPath(workspace)))) return null; }
      return { buildId };
    } catch { return null; }
  }
  async function resumeH3Worker(input: { workspace: string; buildId: string }): Promise<{ ready: boolean; taskId?: string; reason?: string }> {
    if (!safeId(input.buildId)) return { ready: false, reason: 'Invalid existing build ID.' };
    try {
      const workspace = await realpath(input.workspace);
      const runtime = path.join(workspace, 'hypit.runtime.json');
      if (!inside(workspace, await realpath(runtime))) return { ready: false, reason: 'The job runtime is not isolated.' };
      const cfg = await configuration();
      const profile = await jsonFile(runtime);
      const endpoint = profile.endpoints?.[H3_ENDPOINT];
      const expected = cfg.profile.endpoints[H3_ENDPOINT];
      if (profile.format !== 'hypit.runtime-local@1' || typeof profile.dataRoot !== 'string' ||
        path.resolve(workspace, profile.dataRoot) !== path.join(workspace, '.hypit/execution') ||
        Object.keys(profile.endpoints ?? {}).length !== 1 || endpoint?.use !== provider ||
        profile.bindings?.[H3_CAPABILITY] !== H3_ENDPOINT || endpoint.config?.baseUrl !== expected.config.baseUrl ||
        endpoint.config?.apiKey?.store !== expected.config.apiKey.store || endpoint.config?.apiKey?.key !== expected.config.apiKey.key ||
        (route === 'sixref-v1' && JSON.stringify(endpoint.config) !== JSON.stringify(expected.config)) ||
        JSON.stringify(profile.credentials) !== JSON.stringify(cfg.profile.credentials))
        return { ready: false, reason: 'The existing job runtime does not match the isolated account 01 configuration.' };
      const dataRoot = await realpath(path.resolve(workspace, profile.dataRoot));
      if (!inside(workspace, dataRoot)) return { ready: false, reason: 'The job execution ledger is not isolated.' };
      const receipt = await recoverH3Submission(workspace);
      if (receipt?.buildId !== input.buildId) return { ready: false, reason: 'The existing build is not established by the job ledger.' };
      const status = await execute(cfg.cli, ['status', input.buildId, '--workspace', workspace, '--runtime', runtime, '--verbose'], workspace, 30000);
      const build = status.build;
      if (status.format !== 'hypit.cli-status@1' || build?.id !== input.buildId || build.targets?.length !== 1 || build.targets[0] !== OUTPUT)
        return { ready: false, reason: 'The existing build could not be verified.' };
      if (build.result?.state === 'complete' && build.work?.outcome === 'complete') return { ready: true };
      if (!['submitting', 'working'].includes(build.work?.state) || ['failed', 'cancelled'].includes(build.result?.state))
        return { ready: false, reason: 'The existing build is not active.' };
      // The pinned provider checkpoints handle+receipt atomically after remote acceptance.
      // Without that acknowledgement, restarting may replay an uncertain paid submission.
      const operations = build.operations;
      if (!Array.isArray(operations) || operations.length !== 1 || operations[0].endpoint !== H3_ENDPOINT ||
        !['pending', 'completed'].includes(operations[0].state) || !safeId(operations[0].receipt?.id))
        return { ready: false, reason: 'No durable upstream task receipt is available. Manual reconciliation is required before restarting execution.' };
      const taskId = operations[0].receipt.id as string;
      const activity = await execute(cfg.cli, ['activity', '--workspace', workspace, '--runtime', runtime, '--verbose'], workspace, 30000);
      if (activity.format !== 'hypit.cli-activity@1' || activity.omittedBuilds || !Array.isArray(activity.builds) ||
        activity.builds.length !== 1 || activity.builds[0].id !== input.buildId)
        return { ready: false, taskId, reason: 'The isolated runtime contains ambiguous active work.' };
      const runtimeStatus = await execute(cfg.cli, ['runtime', 'status', '--workspace', cfg.packageRoot, '--runtime', runtime], cfg.packageRoot, 30000);
      if (runtimeStatus.format !== 'hypit.cli-runtime-status@1') return { ready: false, taskId, reason: 'Runtime status is unavailable.' };
      if (runtimeStatus.worker?.state === 'running') return { ready: true, taskId };
      if (runtimeStatus.worker?.state !== 'stopped') return { ready: false, taskId, reason: 'Runtime worker state is unknown.' };
      // `runtime up` has no --package-root option. The vendor workspace selects provider code;
      // the explicit per-job profile retains the existing ledger and durable Build definition.
      const started = await execute(cfg.cli, ['runtime', 'up', '--workspace', cfg.packageRoot, '--runtime', runtime,
        '--endpoint', H3_ENDPOINT, '--max-wait-ms', '60000'], cfg.packageRoot, 90000);
      if (started.format !== 'hypit.cli-runtime-up@1' || started.ready !== true || started.worker !== 'running')
        return { ready: false, taskId, reason: 'The existing runtime worker could not be resumed.' };
      return { ready: true, taskId };
    } catch { return { ready: false, reason: 'Unable to safely resume the existing H3 task. Its submission must not be repeated.' }; }
  }
  async function collectH3(input: { workspace: string; buildId: string; to: string }): Promise<void> {
    if (!safeId(input.buildId)) throw new Error('Invalid build ID.');
    const cfg = await configuration();
    if (route === 'sixref-v1') {
      if (!await jobRuntimeMatches(input.workspace, cfg.profile)) throw new Error('The job runtime does not match the selected H3 route.');
      const receipt = await jsonFile(receiptPath(input.workspace));
      if (!routeMatches(receipt) || receipt.buildId !== input.buildId) throw new Error('The job receipt does not match the selected H3 route.');
    } else {
      const receipt = await jsonFile(receiptPath(input.workspace)).catch(() => null);
      if (receipt && !routeMatches(receipt)) throw new Error('The job receipt does not match the selected H3 route.');
      const jobProfile = await jsonFile(path.join(input.workspace, 'hypit.runtime.json')).catch(() => null);
      if (jobProfile && jobProfile.endpoints?.[H3_ENDPOINT]?.use !== provider) throw new Error('The job runtime does not match the selected H3 route.');
    }
    const result = await execute(cfg.cli, ['inspect', input.buildId, '--output', OUTPUT, '--workspace', input.workspace], input.workspace, 30000);
    const output = result.build?.outputs?.find((item: Json) => item.name === OUTPUT);
    if (result.format !== 'hypit.cli-inspect@1' || result.build?.id !== input.buildId || result.build.outcome !== 'complete' ||
      output?.kind !== 'resource' || output.mediaType !== 'video/mp4') throw new Error('The completed H3 MP4 output is not available.');
    const exported = path.join(input.workspace, `hypit-export-${input.buildId}.mp4`);
    const validVideo = async (file: string) => {
      try {
        const actual = await realpath(file);
        const bytes = await stat(actual);
        if (!bytes.isFile() || bytes.size < 12 || (typeof output.size === 'number' && bytes.size !== output.size)) return false;
        const handle = await open(actual, 'r');
        try { const header = Buffer.alloc(12); await handle.read(header, 0, 12, 0); return header.toString('ascii', 4, 8) === 'ftyp'; }
        finally { await handle.close(); }
      } catch { return false; }
    };
    const sameVideo = async (file: string, expected: string) => {
      if (!await validVideo(file)) return false;
      const digest = async (target: string) => {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(target)) hash.update(chunk);
        return hash.digest('hex');
      };
      return await digest(file) === await digest(expected);
    };
    if (!await validVideo(exported)) {
      // A partial earlier export stays intact; a fresh unique destination lets read-only export recover.
      const destination = existsSync(exported) ? path.join(input.workspace, `hypit-export-${input.buildId}-${randomUUID()}.mp4`) : exported;
      const get = await execute(cfg.cli, ['get', input.buildId, '--output', OUTPUT, '--to', destination, '--workspace', input.workspace], input.workspace, 120000);
      if (get.format !== 'hypit.cli-get@1' || get.kind !== 'resource' || get.output !== OUTPUT || !await validVideo(destination)) throw new Error('H3 output export failed.');
      if (destination !== exported) {
        if (await sameVideo(input.to, destination)) return;
        await copyFile(destination, input.to, 1);
        return;
      }
    }
    if (await sameVideo(input.to, exported)) return;
    // Never replace unrelated destination content; a verified earlier copy may be reused after a crash.
    await copyFile(exported, input.to, 1);
  }
  return { runnerReadiness, submitH3, inspectH3, collectH3, recoverH3Submission, resumeH3Worker };
}
export const { runnerReadiness, submitH3, inspectH3, collectH3, recoverH3Submission, resumeH3Worker } = createHypitRunner();
export const sixRefRunner = createHypitRunner({ route: 'sixref-v1' });
