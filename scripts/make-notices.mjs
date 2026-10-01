#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES for the production dependency tree and enforces the license allowlist.
//
//   node scripts/make-notices.mjs --check                 fail if a production dependency has a license outside the allowlist
//   node scripts/make-notices.mjs --out THIRD_PARTY_NOTICES
//
// The single-file binaries bundle every production dependency, so MIT/ISC/BSD notices must ship with them.
// The production set is the dependency GRAPH reachable from the root `dependencies` in
// npm-shrinkwrap.json (including optional and peer edges of reachable packages), not a flag filter:
// a package that is reachable but not installed on this machine is an error, never silently skipped.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies } from './lib/spdx.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'MPL-2.0', 'BlueOak-1.0.0', 'Python-2.0', 'CC0-1.0']);

function resolveFrom(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[candidate]) {
      const entry = packages[candidate];
      // A `link: true` entry points at the real package directory, which holds the dependencies.
      return entry.link && entry.resolved && packages[entry.resolved] ? entry.resolved : candidate;
    }
    if (base === '') return null;
    const idx = base.lastIndexOf('/node_modules/');
    base = idx === -1 ? '' : base.slice(0, idx);
  }
}

export function productionPackages() {
  const lock = JSON.parse(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'));
  const packages = lock.packages;
  const seen = new Set();
  const queue = [];
  const enqueue = (from, deps, optional) => {
    for (const name of Object.keys(deps ?? {})) {
      const path = resolveFrom(packages, from, name);
      if (path === null) {
        if (!optional) throw new Error(`${name} (required by ${from || 'the root package'}) is not in npm-shrinkwrap.json`);
        continue;
      }
      if (!seen.has(path)) {
        seen.add(path);
        queue.push(path);
      }
    }
  };
  enqueue('', packages[''].dependencies, false);
  enqueue('', packages[''].optionalDependencies, true);
  while (queue.length) {
    const path = queue.shift();
    const meta = packages[path];
    enqueue(path, meta.dependencies, false);
    enqueue(path, meta.optionalDependencies, true);
    const requiredPeers = Object.fromEntries(
      Object.entries(meta.peerDependencies ?? {}).filter(([name]) => !meta.peerDependenciesMeta?.[name]?.optional),
    );
    const optionalPeers = Object.fromEntries(
      Object.entries(meta.peerDependencies ?? {}).filter(([name]) => meta.peerDependenciesMeta?.[name]?.optional),
    );
    enqueue(path, requiredPeers, false);
    enqueue(path, optionalPeers, true);
  }

  const out = [];
  const notInstalled = [];
  for (const path of seen) {
    const dir = join(root, path);
    if (!existsSync(join(dir, 'package.json'))) {
      notInstalled.push(path);
      continue;
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
    const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f));
    out.push({
      name: pkg.name,
      version: pkg.version,
      license: license ?? 'UNKNOWN',
      text: licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : null,
    });
  }
  if (notInstalled.length) {
    throw new Error(`production dependencies are in the shrinkwrap but not installed here (run npm ci): ${notInstalled.join(', ')}`);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const args = process.argv.slice(2);
let packages;
try {
  packages = productionPackages();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
const bad = packages.filter((p) => !satisfies(p.license, ALLOWED));
if (bad.length) {
  console.error('Production dependencies with a license outside the allowlist:');
  for (const p of bad) console.error(`  ${p.name}@${p.version}: ${p.license}`);
  process.exit(1);
}
const missingText = packages.filter((p) => !p.text);
if (missingText.length) {
  console.error('Production dependencies without a license file (add the text to the notices by hand):');
  for (const p of missingText) console.error(`  ${p.name}@${p.version}: ${p.license}`);
  process.exit(1);
}

if (args.includes('--check')) {
  console.log(`ok: ${packages.length} production packages, all licenses allowed`);
} else {
  const outIdx = args.indexOf('--out');
  if (outIdx === -1) throw new Error('pass --check or --out <file>');
  const header = 'hgi bundles the following third-party software. Their licenses are reproduced below.\n';
  const body = packages
    .map((p) => `\n${'-'.repeat(72)}\n${p.name}@${p.version} (${p.license})\n${'-'.repeat(72)}\n${p.text}\n`)
    .join('');
  writeFileSync(args[outIdx + 1], header + body);
  console.log(`wrote ${args[outIdx + 1]} (${packages.length} packages)`);
}
