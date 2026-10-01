import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

describe('docs/compatibility.md', () => {
  const doc = fs.readFileSync('docs/compatibility.md', 'utf8');

  it('lists exactly the MCP protocol versions the bundled SDK supports', () => {
    const section = doc.split(/^## Supported MCP protocol versions$/m)[1]?.split(/^## /m)[0] ?? '';
    const listed = [...section.matchAll(/^- `(\d{4}-\d{2}-\d{2})`/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...SUPPORTED_PROTOCOL_VERSIONS].sort());
  });

  it('is linked from the README', () => {
    expect(fs.readFileSync('README.md', 'utf8')).toContain('docs/compatibility.md');
  });
});

describe('no telemetry', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  it('the only hard-coded hosts in src/ are the default server and loopback', () => {
    const allowed = new Set(['phoenix.hginsights.com', 'localhost', '127.0.0.1']);
    const hosts = new Set<string>();
    for (const file of walk('src').filter((f) => f.endsWith('.ts') && !f.includes(`${path.sep}generated${path.sep}`))) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) hosts.add(m[1] as string);
    }
    const unexpected = [...hosts].map((h) => h.replace(/\.$/, '')).filter((h) => !allowed.has(h));
    expect(unexpected).toEqual([]);
  });

  it('the README states that hgi has no telemetry', () => {
    expect(fs.readFileSync('README.md', 'utf8')).toMatch(/no telemetry/i);
  });
});
