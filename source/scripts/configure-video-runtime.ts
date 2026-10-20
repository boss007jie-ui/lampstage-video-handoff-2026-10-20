import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_HYPIT_PACKAGE_ROOT, H3_CAPABILITY, H3_ENDPOINT, H3_PROVIDER, SIXREF_PROVIDER } from '../apps/web/lib/video/hypit-runner';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Configure an isolated account 01 video runtime (never reads or stores secret values).\nUsage: tsx scripts/configure-video-runtime.ts --path <NEW-profile.json> [--route legacy|sixref-v1] [--env | --store platform|os --key <confirmed-account01-reference> [--service <locker-service>]] [--package-root <Hypit-project>]');
    return;
  }
  const values = new Map<string, string>();
  let useEnv = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') { useEnv = true; continue; }
    if (!['--path', '--route', '--store', '--key', '--service', '--package-root'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid configuration arguments. Use --help.');
    values.set(args[i], args[++i]);
  }
  if (!values.get('--path')) throw new Error('--path is required and must identify a new isolated file.');
  const route = values.get('--route') ?? 'legacy';
  if (!['legacy', 'sixref-v1'].includes(route)) throw new Error('Unsupported video route.');
  const provider = route === 'sixref-v1' ? SIXREF_PROVIDER : H3_PROVIDER;
  const runtime = path.resolve(values.get('--path')!);
  const store = useEnv ? 'env' : values.get('--store');
  const key = useEnv ? 'RUNNINGHUB_API_KEY_01' : values.get('--key');
  if (!store || !['env', 'platform', 'os'].includes(store) || !key || /(?:^|[_ .-])0?2$/u.test(key)) throw new Error('Supply --env or an explicit, confirmed account 01 platform/os key reference.');
  if (useEnv && ['--store', '--key', '--service'].some(flag => values.has(flag))) throw new Error('--env cannot be combined with locker options.');
  const packageRoot = path.resolve(values.get('--package-root') ?? DEFAULT_HYPIT_PACKAGE_ROOT);
  await access(path.join(packageRoot, 'packages', provider, 'package.json'));
  const profile = {
    format: 'hypit.runtime-local@1', dataRoot: './video-runtime-state',
    credentials: { [store]: { use: `@hypit/credential-store-${store}`, ...(values.get('--service') ? { config: { service: values.get('--service') } } : {}) } },
    endpoints: { [H3_ENDPOINT]: { use: provider, pool: H3_ENDPOINT, config: {
      baseUrl: 'https://www.runninghub.cn', apiKey: { store, key }, instanceType: route === 'sixref-v1' ? 'default' : 'ultra',
      ...(route === 'sixref-v1' ? { firstPassMegapixels: 0.4096, upscaleFactor: 1.5 } : {}),
      pollIntervalMs: 5000, timeoutMs: 1800000,
    } } }, bindings: { [H3_CAPABILITY]: H3_ENDPOINT },
  };
  await mkdir(path.dirname(runtime), { recursive: true });
  await writeFile(runtime, JSON.stringify(profile, null, 2), { flag: 'wx' });
  await writeFile(`${runtime}.account.json`, JSON.stringify({ account: '01', ...(route === 'sixref-v1' ? { route } : {}), endpoint: H3_ENDPOINT, credential: { store, key }, packageRoot }, null, 2), { flag: 'wx' });
  console.log(`Created isolated account 01 runtime. Set ${route === 'sixref-v1' ? 'VIDEO_SIXREF_HYPIT_RUNTIME' : 'VIDEO_HYPIT_RUNTIME'} to ${runtime}. Credentials were not read or changed.`);
}
main().catch(() => { console.error('Video runtime configuration failed. Use --help; choose a new path and a supported explicit account 01 credential reference.'); process.exitCode = 1; });
