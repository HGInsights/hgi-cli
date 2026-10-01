import fs from 'node:fs';
import { expect } from 'vitest';
import { credentialsFile, readCreds, runCli, type CliResult, type Sandbox } from './cli.js';
import { FakeServer, READ_TOOL, UNANNOTATED_TOOL, WRITE_TOOL, textResult } from './fake-server.js';

export function seedServer(server: FakeServer): void {
  server.reset();
  server.tools = [READ_TOOL, WRITE_TOOL, UNANNOTATED_TOOL];
  server.handlers.clear();
  server.handlers.set('company_lookup', (args) => textResult({ domain: args.domain, name: 'Acme', employees: 120 }, 2));
  server.handlers.set('start_agent', () => textResult({ run_id: 'r1' }, 5));
  server.handlers.set('aggregated_thing', () => textResult({ ok: true }, null));
}

export async function login(sb: Sandbox, extra: string[] = []): Promise<CliResult> {
  const res = await runCli([...extra, 'auth', 'login'], sb.env);
  expect(res.code, res.stderr).toBe(0);
  return res;
}

export function editCreds(sb: Sandbox, mutate: (c: Record<string, unknown>) => void): void {
  const file = credentialsFile(sb);
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  mutate(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function expireAccessToken(sb: Sandbox): void {
  editCreds(sb, (c) => {
    c.expires_at = Date.now() - 1000;
  });
}

export function errorBody(res: CliResult): { schema: number; error: { code: string; exit_code: number; message: string; hint?: string; details?: Record<string, unknown> } } {
  const match = /\{"schema":1.*\}\s*$/m.exec(res.stderr.trim());
  if (!match) throw new Error(`no JSON error body in stderr: ${res.stderr}`);
  return JSON.parse(match[0]);
}

export { readCreds };
