import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hgiShellCommand, makeSandbox, runCli, type CliResult, type Sandbox } from '../support/cli.js';
import { errorBody, login, seedServer } from '../support/e2e.js';
import { FakeServer, textResult } from '../support/fake-server.js';

const server = new FakeServer();
let sb: Sandbox;

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
  seedServer(server);
  sb = makeSandbox(server.base, { HGI_BUDGET_ID: 't' });
});
afterEach(() => {
  try {
    fs.chmodSync(path.join(sb.configDir, 'budgets'), 0o700);
  } catch {
    // never created
  }
  sb.cleanup();
});

const budgetsDir = () => path.join(sb.configDir, 'budgets');
const lookup = (args: string[] = [], env: NodeJS.ProcessEnv = sb.env) =>
  runCli(['call', 'company_lookup', '--input', '{"domain":"acme.com"}', ...args], env);
const status = async (args: string[] = [], env: NodeJS.ProcessEnv = sb.env) => {
  const res = await runCli(['budget', 'status', ...args], env);
  expect(res.code, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
};

function expectError(res: CliResult, exit: number, code: string) {
  expect(res.code, res.stderr).toBe(exit);
  const { error } = errorBody(res);
  expect(error.code).toBe(code);
  expect(error.exit_code).toBe(exit);
  return error;
}

/** Spawns `sh -c script`, so every hgi in it has the same parent process. */
function runShell(script: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Story 3: cap the spend of one run', () => {
  beforeEach(() => login(sb));

  it('stops before the call that would start over the cap, sending nothing', async () => {
    for (const spent of [2, 4, 6]) {
      const res = await lookup(['--max-credits', '5']);
      expect(res.code, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout)).toMatchObject({ name: 'Acme' });
      expect(await status()).toMatchObject({ spent });
    }
    const before = server.requests.length;
    const err = expectError(await lookup(['--max-credits', '5']), 13, 'budget_exceeded');
    expect(err.details).toEqual({ spent: 6, max: 5, budget_id: 't' });
    expect(err.hint).toMatch(/Nothing was sent/);
    expect(server.requests.length).toBe(before);
    expect(server.toolCalls()).toHaveLength(3);
  });

  it('HGI_MAX_CREDITS works like the flag, and the flag wins', async () => {
    const env = { ...sb.env, HGI_MAX_CREDITS: '5' };
    for (let i = 0; i < 3; i += 1) expect((await lookup([], env)).code).toBe(0);
    expectError(await lookup([], env), 13, 'budget_exceeded');
    expect((await lookup(['--max-credits', '10'], env)).code).toBe(0);
    expect(await status([], env)).toMatchObject({ spent: 8, max: 5 });
  });

  it('hgi calls from one parent share a budget without HGI_BUDGET_ID; different ids do not', async () => {
    const env: NodeJS.ProcessEnv = { ...sb.env, HGI_MAX_CREDITS: '100' };
    delete env.HGI_BUDGET_ID;
    const hgi = hgiShellCommand();
    const call = `${hgi} call company_lookup --input '{"domain":"acme.com"}' >/dev/null`;
    const res = await runShell(`${call} && ${call} && ${hgi} budget status; true`, env);
    expect(res.code, res.stderr).toBe(0);
    const shared = JSON.parse(res.stdout.trim().split('\n').pop() as string) as Record<string, unknown>;
    expect(shared).toMatchObject({ spent: 4, calls: 2 });
    expect(shared.budget_id).toMatch(/^\d+$/);

    await lookup(['--max-credits', '100'], { ...sb.env, HGI_BUDGET_ID: 'a' });
    await lookup(['--max-credits', '100'], { ...sb.env, HGI_BUDGET_ID: 'b' });
    expect(await status([], { ...sb.env, HGI_BUDGET_ID: 'a' })).toMatchObject({ spent: 2, calls: 1 });
    expect(await status([], { ...sb.env, HGI_BUDGET_ID: 'b' })).toMatchObject({ spent: 2, calls: 1 });
  });

  it('an error result with a cost counts; a result with no cost counts as unknown', async () => {
    server.handlers.set('company_lookup', () => ({ isError: true, content: [{ type: 'text', text: 'Bad domain.' }], _meta: { creditCost: 3 } }));
    expectError(await lookup(['--max-credits', '50']), 3, 'tool_error');
    expect(await status()).toMatchObject({ spent: 3, calls: 1, unknown_cost_calls: 0 });
    server.handlers.set('company_lookup', () => textResult({ ok: true }, null));
    expect((await lookup(['--max-credits', '50'])).code).toBe(0);
    expect(await status()).toMatchObject({ spent: 3, calls: 2, unknown_cost_calls: 1 });
  });

  it('hgi run ignores HGI_MAX_CREDITS, records nothing, and rejects --max-credits', async () => {
    const env = { ...sb.env, HGI_MAX_CREDITS: '0' };
    const res = await runCli(['run', 'start_agent', '--input', '{"agent":"x"}'], env);
    expect(res.code, res.stderr).toBe(0);
    expect(fs.existsSync(budgetsDir())).toBe(false);
    const bad = await runCli(['run', 'start_agent', '--input', '{"agent":"x"}', '--max-credits', '5'], sb.env);
    expectError(bad, 2, 'invalid_input');
  });

  it('without a cap, hgi call creates no budgets/ directory', async () => {
    expect((await lookup()).code).toBe(0);
    expect(fs.existsSync(budgetsDir())).toBe(false);
  });

  it('hgi call --help documents the cap and both variables', async () => {
    const res = await runCli(['call', '--help'], sb.env);
    expect(res.code).toBe(0);
    for (const text of ['--max-credits', 'HGI_MAX_CREDITS', 'HGI_BUDGET_ID']) expect(res.stdout).toContain(text);
  });
});

describe('Story 4: prove a run is free', () => {
  it('--max-credits 0 refuses the first call before any request, even signed out', async () => {
    expectError(await lookup(['--max-credits', '0']), 13, 'budget_exceeded');
    await login(sb);
    server.requests = [];
    expectError(await lookup(['--max-credits', '0']), 13, 'budget_exceeded');
    expect(server.requests).toEqual([]);
  });
});

describe('Story 5: see and reset what a run has spent', () => {
  it('status reports spend, cap and remaining; reset starts over for this id only', async () => {
    await login(sb);
    for (let i = 0; i < 3; i += 1) expect((await lookup(['--max-credits', '5'])).code).toBe(0);
    const piped = await runCli(['budget', 'status'], sb.env);
    expect(piped.stdout.trim()).toBe('{"budget_id":"t","spent":6,"max":5,"remaining":0,"calls":3,"unknown_cost_calls":0}');
    expect(await status(['--max-credits', '20'])).toMatchObject({ max: 20, remaining: 14 });
    expect(await status([], { ...sb.env, HGI_MAX_CREDITS: '8' })).toMatchObject({ max: 8, remaining: 2 });

    const csv = await runCli(['budget', 'status', '-f', 'csv'], sb.env);
    expect(csv.stdout.split(/\r?\n/)[0]).toBe('budget_id,spent,max,remaining,calls,unknown_cost_calls');
    const table = await runCli(['budget', 'status', '-f', 'table'], sb.env);
    for (const col of ['budget_id', 'spent', 'remaining', 'unknown_cost_calls']) expect(table.stdout).toContain(col);

    expect((await lookup(['--max-credits', '50'], { ...sb.env, HGI_BUDGET_ID: 'other' })).code).toBe(0);
    const otherFile = path.join(budgetsDir(), `${createHash('sha256').update('other').digest('hex').slice(0, 16)}.json`);
    const otherBytes = fs.readFileSync(otherFile, 'utf8');

    const reset = await runCli(['budget', 'reset'], sb.env);
    expect(reset.code, reset.stderr).toBe(0);
    expect(JSON.parse(reset.stdout)).toEqual({ budget_id: 't', spent: 0, max: 5, remaining: 5, calls: 0, unknown_cost_calls: 0 });
    expect(fs.readFileSync(otherFile, 'utf8')).toBe(otherBytes);
    expect((await lookup(['--max-credits', '5'])).code).toBe(0);
  });

  it('a fresh id with no cap reports zeros and nulls', async () => {
    expect(await status()).toEqual({ budget_id: 't', spent: 0, max: null, remaining: null, calls: 0, unknown_cost_calls: 0 });
  });

  it('status and reset need no credentials and send nothing', async () => {
    server.requests = [];
    expect(fs.existsSync(path.join(sb.configDir))).toBe(false);
    expect((await runCli(['budget', 'status'], sb.env)).code).toBe(0);
    expect((await runCli(['budget', 'reset'], sb.env)).code).toBe(0);
    expect(server.requests).toEqual([]);
  });
});

describe('Story 6: broken or unexpected state fails safely', () => {
  it.each([
    [['--max-credits', '-1'], {}],
    [['--max-credits', '1.5'], {}],
    [[], { HGI_MAX_CREDITS: 'abc' }],
  ])('an invalid cap %j %j exits 2 and sends nothing', async (args, extra) => {
    await login(sb);
    server.requests = [];
    const err = expectError(await lookup(args, { ...sb.env, ...extra }), 2, 'invalid_input');
    expect(err.details?.reason).toBe('max_credits');
    expect(server.requests).toEqual([]);
  });

  it('a corrupt budget file fails closed and sends nothing', async () => {
    await login(sb);
    expect((await lookup(['--max-credits', '5'])).code).toBe(0);
    const [file] = fs.readdirSync(budgetsDir()).filter((f) => f.endsWith('.json'));
    fs.writeFileSync(path.join(budgetsDir(), file as string), '{nope');
    server.requests = [];
    const err = expectError(await lookup(['--max-credits', '5']), 12, 'local_state_error');
    expect(err.details?.kind).toBe('budget_corrupt');
    expect(server.requests).toEqual([]);
  });

  describe.skipIf(process.getuid?.() === 0)('a budget write that fails after the call', () => {
    beforeEach(async () => {
      await login(sb);
      expect((await lookup(['--max-credits', '50'])).code).toBe(0);
    });
    /** The handler runs while hgi waits for the result, after its pre-call check released the lock. */
    const lockBudgetsDuringCall = (result: () => ReturnType<typeof textResult>) =>
      server.handlers.set('company_lookup', () => {
        fs.chmodSync(budgetsDir(), 0o500);
        return result();
      });

    it('prints the result on stdout and exits 12 tool_ran', async () => {
      lockBudgetsDuringCall(() => textResult({ name: 'Acme' }, 2));
      const res = await lookup(['--max-credits', '50']);
      expect(JSON.parse(res.stdout)).toEqual({ name: 'Acme' });
      expect(res.code, res.stderr).toBe(12);
      const { error } = errorBody(res);
      expect(error.details).toMatchObject({ kind: 'budget_write_failed', tool_ran: true });
      expect(error.hint).toMatch(/Do NOT re-run/);
    });

    it('prints the result on stdout even with --out', async () => {
      lockBudgetsDuringCall(() => textResult({ name: 'Acme' }, 2));
      const out = path.join(sb.dir, 'result.json');
      const res = await lookup(['--max-credits', '50', '--out', out]);
      expect(JSON.parse(res.stdout)).toEqual({ name: 'Acme' });
      expect(errorBody(res).error.details).toMatchObject({ kind: 'budget_write_failed', tool_ran: true });
    });

    it('keeps a server refusal as the error, flagged budget_write_failed', async () => {
      lockBudgetsDuringCall(() => ({
        isError: true,
        content: [{ type: 'text', text: 'Budget service down.' }],
        _meta: { errorCode: 'governance_unavailable' },
      }));
      const err = expectError(await lookup(['--max-credits', '50']), 7, 'governance_unavailable');
      expect(err.details).toMatchObject({ retryable: true, budget_write_failed: true, server_error_code: 'governance_unavailable' });
    });
  });

  it('budget files are 0600 in a 0700 dir, and a hostile id stays inside budgets/', async () => {
    await login(sb);
    expect((await lookup(['--max-credits', '5'], { ...sb.env, HGI_BUDGET_ID: '../../x' })).code).toBe(0);
    const files = fs.readdirSync(budgetsDir()).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.json$/);
    expect(fs.statSync(budgetsDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(budgetsDir(), files[0] as string)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(sb.dir).sort()).toEqual(['cache', 'config']);
  });

  it('a symlink at the budget file path is refused', async () => {
    await login(sb);
    expect((await lookup(['--max-credits', '5'])).code).toBe(0);
    const [file] = fs.readdirSync(budgetsDir()).filter((f) => f.endsWith('.json'));
    const target = path.join(sb.dir, 'target.json');
    fs.writeFileSync(target, 'untouched');
    fs.rmSync(path.join(budgetsDir(), file as string));
    fs.symlinkSync(target, path.join(budgetsDir(), file as string));
    const err = expectError(await lookup(['--max-credits', '5']), 12, 'local_state_error');
    expect(err.details?.kind).toBe('budget_corrupt');
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
  });
});
