#!/usr/bin/env node
// CycloneDX SBOM for a release: the production npm dependencies (from npm-shrinkwrap.json) plus the
// Node.js runtime that the single-file binaries bundle, with its own bundled components
// (OpenSSL, V8, ICU, zlib ...) taken from process.versions of the PINNED Node.
//
//   node scripts/make-sbom.mjs --node <path to the pinned node binary> --out hgi-v0.1.0.sbom.cdx.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const nodeBin = arg('--node') ?? process.execPath;
const out = arg('--out');
if (!out) throw new Error('pass --out <file>');

const pinned = JSON.parse(readFileSync(resolve(root, 'packaging/node-sha256.json'), 'utf8'));
const versions = JSON.parse(execFileSync(nodeBin, ['-p', 'JSON.stringify(process.versions)'], { encoding: 'utf8' }));
if (`v${versions.node}` !== pinned.version) {
  throw new Error(`the Node used for the SBOM is v${versions.node}, but packaging/node-sha256.json pins ${pinned.version}`);
}

const sbom = JSON.parse(
  execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev', '--package-lock-only'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
);

const bundled = ['openssl', 'v8', 'icu', 'zlib', 'uv', 'nghttp2', 'llhttp', 'ada', 'brotli', 'cares', 'unicode', 'undici', 'simdutf', 'sqlite']
  .filter((name) => versions[name])
  .map((name) => ({
    type: 'library',
    'bom-ref': `node-bundled:${name}`,
    name,
    version: versions[name],
    description: 'Bundled inside the Node.js runtime embedded in the hgi binaries',
  }));

const nodeComponent = {
  type: 'platform',
  'bom-ref': `node-runtime:${versions.node}`,
  name: 'nodejs',
  version: versions.node,
  licenses: [{ license: { id: 'MIT' } }],
  purl: `pkg:generic/nodejs@${versions.node}`,
  description: 'Node.js runtime embedded in the hgi single-file binaries (not present in the npm package)',
  externalReferences: [{ type: 'distribution', url: pinned.source }],
  properties: Object.values(pinned.files).map((f) => ({ name: `sha256:${f.name}`, value: f.sha256 })),
  components: bundled,
};

sbom.components = [...(sbom.components ?? []), nodeComponent];
writeFileSync(out, JSON.stringify(sbom, null, 2) + '\n');
console.log(`wrote ${out}: ${sbom.components.length} top-level components`);
