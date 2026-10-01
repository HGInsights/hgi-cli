import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const render = (version: string, sums: string) =>
  spawnSync('bash', ['scripts/render-formula.sh', version, sums], { encoding: 'utf8' });

describe('Homebrew formula rendering', () => {
  it('fills the version, urls and one SHA-256 per platform', () => {
    const res = render('1.2.3', 'test/fixtures/SHA256SUMS');
    expect(res.status, res.stderr).toBe(0);
    const formula = res.stdout;
    expect(formula).not.toMatch(/@[A-Z0-9_]+@/);
    expect(formula).toContain('version "1.2.3"');
    for (const [target, digit] of [['darwin-arm64', '1'], ['darwin-x64', '2'], ['linux-arm64', '3'], ['linux-x64', '4']] as const) {
      expect(formula).toContain(`releases/download/v1.2.3/hgi-v1.2.3-${target}.tar.gz"`);
      expect(formula).toContain(`sha256 "${digit.repeat(64)}"`);
    }
    expect(formula).toContain('skip_clean "bin/hgi"');
    expect(formula).toMatch(/assert_equal version\.to_s, shell_output\("#\{bin\}\/hgi --version"\)\.strip/);
  });

  it('passes a Ruby syntax check when ruby is available', () => {
    const ruby = spawnSync('ruby', ['-v']);
    if (ruby.status !== 0) return;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-formula-')), 'hgi.rb');
    fs.writeFileSync(file, render('1.2.3', 'test/fixtures/SHA256SUMS').stdout);
    expect(execFileSync('ruby', ['-c', file], { encoding: 'utf8' })).toContain('Syntax OK');
  });

  it('renders a local-install formula for a release candidate with file:// urls', () => {
    const res = spawnSync('bash', ['scripts/render-formula.sh', '1.2.3-rc.1', 'test/fixtures/SHA256SUMS-rc', '--local-dir', '/tmp/rel'], { encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('url "file:///tmp/rel/hgi-v1.2.3-rc.1-linux-x64.tar.gz"');
    expect(res.stdout).toContain('version "1.2.3-rc.1"');
  });

  it('refuses release candidates and incomplete checksum files', () => {
    expect(render('1.2.3-rc.1', 'test/fixtures/SHA256SUMS').status).not.toBe(0);
    const partial = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-sums-')), 'SHA256SUMS');
    fs.writeFileSync(partial, fs.readFileSync('test/fixtures/SHA256SUMS', 'utf8').split('\n').slice(0, 3).join('\n') + '\n');
    const res = render('1.2.3', partial);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('linux-x64');
  });
});
