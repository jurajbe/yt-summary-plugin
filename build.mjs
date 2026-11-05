// Bundles the extension into dist/ (load that folder via "Load unpacked").
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const out = 'dist';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  legalComments: 'none',
  logLevel: 'info',
};

await esbuild.build({
  ...common,
  entryPoints: {
    background: 'src/background.js',
    content: 'src/content/main.js',
    options: 'src/options/options.js',
  },
  outdir: out,
});

await cp('src/manifest.json', `${out}/manifest.json`);
await cp('src/options/options.html', `${out}/options.html`);
await cp('src/options/options.css', `${out}/options.css`);
await cp('src/icons', `${out}/icons`, { recursive: true });
console.log(`Built → ${out}/`);
