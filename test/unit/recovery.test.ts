import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { browserFlowLines, loginTimeoutHint, noBrowserForbiddenLine } from '../../src/auth/recovery.js';

const BASE = 'https://hg.example.test:8443';
const HOST = 'hg.example.test:8443';

describe('403 recovery wording', () => {
  it('the default flow prints the URL, the "page shows an error" fallback and a 403 line naming the configured server', () => {
    const lines = browserFlowLines(BASE, 'https://hg.example.test:8443/oauth/authorize?x=1');
    const text = lines.join('\n');
    expect(lines).toContain('  https://hg.example.test:8443/oauth/authorize?x=1');
    expect(text).toContain('or the page shows an error');
    expect(text).toContain('browser on this computer');
    const forbidden = lines.find((l) => l.includes('403 Forbidden')) as string;
    expect(forbidden).toContain('private window');
    expect(forbidden).toContain(`cookies for ${HOST}`);
    expect(forbidden).toContain(`sign in at ${BASE} first`);
    expect(text).not.toContain('phoenix.hginsights.com');
  });

  it('the --no-browser line speaks of the browser the URL is opened in', () => {
    const line = noBrowserForbiddenLine(BASE);
    expect(line).toContain('403 Forbidden');
    expect(line).toContain('in the browser you open it in');
    expect(line).toContain('private window');
    expect(line).toContain(`cookies for ${HOST}`);
    expect(line).toContain(`sign in at ${BASE} first`);
  });

  it('the timeout hint gives the recovery, then hgi auth login again, and keeps the --no-browser advice', () => {
    const hint = loginTimeoutHint(BASE);
    expect(hint).toContain('403 Forbidden');
    expect(hint).toContain('private window');
    expect(hint).toContain(`sign in at ${BASE} first`);
    expect(hint.indexOf('private window')).toBeLessThan(hint.indexOf('hgi auth login'));
    expect(hint).toContain('--no-browser');
  });
});

describe('README troubleshooting entry for a 403 at sign-in', () => {
  const readme = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('### Troubleshooting'), readme.indexOf('\n## ', readme.indexOf('### Troubleshooting')));
  const entry = section.split('\n').find((l) => l.includes('403 Forbidden')) ?? '';

  it('names the command and the symptom, with the recovery steps', () => {
    expect(entry).toContain('hgi auth login');
    expect(entry).toContain('private window');
    expect(entry).toContain('cookies for');
    expect(entry).toContain('sign in at');
    expect(entry).toContain('open the URL');
  });

  it('describes the symptom and steps only: no request filtering, cookie names, terminals or browsers', () => {
    for (const banned of [/\bWAF\b/i, /firewall/i, /\bALB\b/i, /AWSALB/i, /_session/i, /chrome|safari|firefox|\bedge\b/i, /iterm|warp|vs ?code|cursor|ghostty|terminal app/i]) {
      expect(entry).not.toMatch(banned);
    }
  });
});
