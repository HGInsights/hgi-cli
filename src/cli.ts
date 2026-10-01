import { Command, CommanderError } from 'commander';
import { VERSION } from './config.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerInvokeCommands } from './commands/invoke.js';
import { registerSkillCommands } from './commands/skill.js';
import { registerToolsCommands } from './commands/tools.js';
import { HgiError, renderError, toHgiError } from './errors.js';
import { closeHttp } from './http.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('hgi')
    .description('Command-line client for the HG Insights MCP server')
    .version(VERSION, '-V, --version', 'print the hgi version')
    .option('--base-url <url>', 'server origin (default: $HGI_BASE_URL or https://phoenix.hginsights.com)')
    .option('--debug', 'log requests to stderr (tokens are always redacted)')
    .option('--json-errors', 'always print errors as JSON on stderr')
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, outputError: () => undefined });

  registerAuthCommands(program);
  registerToolsCommands(program);
  registerInvokeCommands(program);
  registerSkillCommands(program);
  return program;
}

function asCliError(err: unknown): unknown {
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') return null;
    return new HgiError('invalid_input', err.message.replace(/^error: /, ''), {
      hint: 'Run `hgi --help` for usage.',
      details: { reason: err.code },
    });
  }
  return err;
}

export async function main(argv: string[]): Promise<number> {
  const jsonErrors = argv.includes('--json-errors') || !process.stderr.isTTY;
  try {
    await buildProgram().parseAsync(argv);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (raw) {
    const mapped = asCliError(raw);
    if (mapped === null) return 0;
    const err = toHgiError(mapped);
    process.stderr.write(renderError(err, jsonErrors));
    return err.exitCode;
  } finally {
    await closeHttp();
  }
}
