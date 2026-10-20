import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(RUNNINGHUB_|VIDEO_HYPIT_|VIDEO_SIXREF_HYPIT_|R2_|AWS_|S3_|DATABASE_URL|DIRECT_URL|OPENAI_|OPENLUX_|GEMINI_|RESEND_|NEXTAUTH_)/i.test(name)) delete env[name];
const result = spawnSync(process.execPath, ['--require', path.join(root, 'scripts/offline-guard.cjs'), '--import', 'tsx',
  path.join(root, 'examples/local-simulated-flow.ts'), ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (result.error) throw new Error('local_example_process_failed');
process.exit(result.status ?? 1);

