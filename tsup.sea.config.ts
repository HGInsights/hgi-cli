import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// One self-contained CommonJS file: a Node single-executable application cannot load node_modules.
// `removeNodeProtocol: false` keeps `node:`-only builtins (node:sqlite, node:sea) resolvable.
export default defineConfig({
  entry: { hgi: 'src/bin.ts' },
  outDir: 'build/sea',
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: false,
  splitting: false,
  shims: true,
  removeNodeProtocol: false,
  noExternal: [/.*/],
  define: { __HGI_VERSION__: JSON.stringify(pkg.version) },
});
