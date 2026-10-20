import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'source/apps/web/scripts/tests/';
const core = ['agent-video-backend-runninghub', 'agent-video-backend-registry', 'agent-video-runtime-state',
  'agent-video-runtime-preparation', 'video-call-contract', 'video-call-engine'].map(name => base + name + '.test.ts');
const media = [base + 'agent-video-runtime-collector.test.ts'];
const group = process.argv[2] ?? 'core';
if (!['core', 'media', 'all'].includes(group)) throw new Error('unknown_test_group');
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(RUNNINGHUB_|VIDEO_HYPIT_|VIDEO_SIXREF_HYPIT_|R2_|AWS_|S3_|DATABASE_URL|DIRECT_URL|OPENAI_|OPENLUX_|GEMINI_|RESEND_|NEXTAUTH_)/i.test(name)) delete env[name];
const tests = group === 'core' ? core : group === 'media' ? media : [...core, ...media];
const result = spawnSync(process.execPath, ['--require', path.join(root, 'scripts/offline-guard.cjs'), '--import', 'tsx',
  '--test', '--test-concurrency=1', '--test-reporter=tap', ...tests], { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (result.error) throw new Error('local_test_process_failed');
process.exit(result.status ?? 1);

