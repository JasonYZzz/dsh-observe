import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixtures, largeFixture } from '../tests/fixtures/rc2.mjs';
import { join } from 'node:path';
const root = process.argv[2] ?? join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@deepseek-ai/dsh');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const baseline = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (manifest.version !== baseline.peerDependencies['@deepseek-ai/dsh']) throw new Error(`Expected @deepseek-ai/dsh@${baseline.peerDependencies['@deepseek-ai/dsh']}`);
const cordis = JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai/cordis/package.json'), 'utf8')).version;
if (cordis !== baseline.dependencies['@deepseek-ai/cordis']) throw new Error(`Expected Cordis ${baseline.dependencies['@deepseek-ai/cordis']}`);
const files = [
  'package.json',
  'node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js',
  'node_modules/@deepseek-ai/dsh-session-telemetry/lib/index.js',
  'node_modules/@deepseek-ai/cordis/package.json',
  'node_modules/@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts',
  'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js',
  'node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts',
  'node_modules/@deepseek-ai/dsh-session-query/lib/types/observation.d.ts',
  'node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts',
  'node_modules/@deepseek-ai/dsh-tools/lib/types/types.d.ts',
  'node_modules/@deepseek-ai/dsh-subagent/lib/types/catalog.d.ts',
  'node_modules/@deepseek-ai/dsh-compaction/lib/types/types.d.ts',
  'node_modules/@deepseek-ai/dsh-client-ui-trajectory/lib/client.js',
];
const sources = [];
for (const path of files) sources.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
await mkdir('docs/verification', { recursive: true });
await writeFile('docs/verification/source-manifest.json', JSON.stringify({ host: manifest.version, node: process.versions.node, cordis, sources }, null, 2) + '\n');
console.log(`Verified ${manifest.version}: ${sources.length} source hashes recorded (no credentials read)`);

const { KNOWN_SESSION_EVENT_TYPES } = await import(pathToFileURL(join(root, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href);
const { assertReleasedV4Relationships } = await import(pathToFileURL(join(root, 'node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')).href);
for (const [name, events] of Object.entries({ ...fixtures, large: largeFixture() })) {
  try { assertReleasedV4Relationships({ header: { id: `fixture-${name}`, version: 4, createdAt: 1000, isSeeded: name === 'fork' }, events, inheritedEventCount: name === 'fork' ? 5 : 0 }, KNOWN_SESSION_EVENT_TYPES); } catch (error) { throw new Error(`${name}: ${error.message}`); }
}
console.log('All fixtures pass native RC.2 cold-log relationship validation');
