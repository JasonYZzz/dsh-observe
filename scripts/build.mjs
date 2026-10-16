import { build } from 'esbuild';
import { mkdir, rm, readdir } from 'node:fs/promises';
await rm('lib', { recursive: true, force: true });
await mkdir('lib', { recursive: true });
await build({ entryPoints: (await readdir('src')).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')).map((file) => `src/${file}`), outdir: 'lib', bundle: false,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external' });
await build({ entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true,
  platform: 'browser', target: 'es2022', format: 'cjs', loader: { '.css': 'text' }, packages: 'external', jsx: 'automatic',
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-observe",factory:(require)=>{const module={exports:{}};const exports=module.exports;' },
  footer: { js: 'return module.exports;}});' } });
