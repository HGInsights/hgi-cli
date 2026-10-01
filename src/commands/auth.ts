import type { Command } from 'commander';
import { discover, getUserinfo, revokeToken } from '../auth/oauth-client.js';
import { inspectCredentials, readCredentials, withLock } from '../auth/credentials-store.js';
import { login } from '../auth/login.js';
import { HgiError } from '../errors.js';
import { buildContext } from './context.js';
import { emit } from './emit.js';

const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Sign in, sign out, and see who you are signed in as');

  auth
    .command('login')
    .description('Sign in through your browser (OAuth, PKCE)')
    .option('--no-browser', 'print the URL and accept a pasted callback URL instead of opening a browser')
    .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
    .action(async (opts: { browser: boolean; format?: string }, cmd: Command) => {
      const ctx = buildContext(cmd);
      const result = await login({ base: ctx.base, credPath: ctx.credPath, noBrowser: !opts.browser, say });
      await emit(result, { format: opts.format });
    });

  auth
    .command('whoami')
    .description('Show the signed-in user and organization (asks the server)')
    .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
    .action(async (opts: { format?: string }, cmd: Command) => {
      const ctx = buildContext(cmd);
      ctx.tokens.loadCredentials();
      const meta = await discover(ctx.base);
      const info = await getUserinfo(
        meta,
        (url) => ctx.authedFetch(url, {}, { redirectKind: 'oauth', context: 'the userinfo endpoint' }),
        'login',
      );
      await emit({ base_url: ctx.base, ...info }, { format: opts.format });
    });

  auth
    .command('logout')
    .description('Revoke your session on the server and delete the local credentials')
    .option('--force', 'delete the local credentials even if the server could not be told')
    .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
    .action(async (opts: { force?: boolean; format?: string }, cmd: Command) => {
      const ctx = buildContext(cmd);
      const outcome = await withLock(ctx.credPath, async (lock) => {
        const found = inspectCredentials(ctx.credPath);
        if (found.status === 'missing') return 'not_signed_in';
        if (found.status === 'corrupt') {
          if (!opts.force) readCredentials(ctx.credPath);
          lock.remove();
          return 'deleted_corrupt';
        }
        const creds = found.creds;
        try {
          const meta = await discover(ctx.base);
          await revokeToken(meta, ctx.base, creds.refresh_token, 'refresh_token');
          await revokeToken(meta, ctx.base, creds.access_token, 'access_token');
        } catch (err) {
          if (!opts.force) {
            const cause = err instanceof HgiError ? err : undefined;
            throw new HgiError(cause?.code ?? 'server_unreachable', `Could not revoke your session: ${cause?.message ?? String(err)} You are NOT signed out.`, {
              hint: 'Your credentials were kept. Retry, or use `hgi auth logout --force` to delete them locally (the server-side token may stay valid for up to 30 days).',
              details: cause?.details,
              cause: err,
            });
          }
          say('warning: the server could not be told to revoke the session; it may stay valid for up to 30 days.');
        }
        lock.remove();
        return 'signed_out';
      });
      await emit({ base_url: ctx.base, result: outcome }, { format: opts.format });
    });
}
