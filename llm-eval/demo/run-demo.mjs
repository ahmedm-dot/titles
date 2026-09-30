// Runs the real promptfooconfig.yaml with every model and judge swapped for a demo stand-in.
// No real API calls, no cost. Usage: npm run demo   (then: npm run view)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { startMockJev } from './mock-jev-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JEV_PORT = 4599;
const file = (p) => `file://${path.join(here, p)}`;

const config = yaml.load(fs.readFileSync(path.join(root, 'promptfooconfig.yaml'), 'utf8'));
// Point relative file:// paths (prompts, tests, the Jev judge) at llm-eval/, since the demo
// config is written to output/.
const absolutize = (v) =>
  typeof v === 'string' && v.startsWith('file://') && !v.startsWith('file:///')
    ? `file://${path.join(root, v.slice(7))}`
    : Array.isArray(v) ? v.map(absolutize)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, absolutize(x)]))
    : v;
Object.assign(config, absolutize(config));
config.description = `[DEMO - fake models and judges] ${config.description}`;
config.providers = config.providers.map((p) => ({
  id: file('mock-generator.mjs'),
  label: p.label,
  config: { model: p.label },
}));
const judges = {
  'anthropic:': { judge: 'Claude', offset: 0 },
  'openai:': { judge: 'GPT', offset: 0.04 },
};
for (const a of config.defaultTest.assert) {
  if (!a.provider) continue;
  const [, cfg] = Object.entries(judges).find(([prefix]) => a.provider.startsWith(prefix));
  a.provider = { id: file('mock-judge.mjs'), config: cfg };
}
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
const demoConfig = path.join(root, 'output', 'demo.config.yaml');
fs.writeFileSync(demoConfig, yaml.dump(config, { lineWidth: -1 }));

const server = await startMockJev(JEV_PORT);
const child = spawn(
  'npx',
  ['promptfoo', 'eval', '-c', demoConfig, '--env-file', path.join(root, '.env.demo'), '--no-cache',
    '-o', path.join(root, 'output', 'demo-report.html'), path.join(root, 'output', 'demo-results.json')],
  { cwd: root, stdio: 'inherit', env: { ...process.env, TYPESAFE_BASE_URL: `http://127.0.0.1:${JEV_PORT}` } },
);
child.on('exit', (code) => {
  server.close();
  console.log('\nDemo report: output/demo-report.html   |   Web UI: npm run view');
  process.exit(code === 100 ? 0 : code ?? 0); // promptfoo exits 100 when some tests fail
});
