import { protectedDirs } from '../config.js';
import { applySelect } from '../output/select.js';
import { defaultFormat, formatValue, parseFormat, type Format } from '../output/format.js';
import { preflightOutFile, writeOutFile } from '../output/out-file.js';
import { escapeJsonForTerminal, sanitizeForTerminal } from '../output/sanitize.js';
import { parseSelect } from '../output/select.js';
import { writeStream } from '../output/stdout.js';

export interface EmitOptions {
  format?: string;
  out?: string;
  select?: string;
  force?: boolean;
  allowForce?: boolean;
}

export function preflightOutput(opts: EmitOptions): void {
  if (opts.format) parseFormat(opts.format);
  if (opts.select !== undefined) parseSelect(opts.select);
  if (opts.out) {
    preflightOutFile(opts.out, {
      force: Boolean(opts.force),
      allowForce: Boolean(opts.allowForce),
      protectedDirs: protectedDirs(),
    });
  }
}

export async function emit(value: unknown, opts: EmitOptions = {}): Promise<void> {
  const isTty = Boolean(process.stdout.isTTY);
  const format = opts.format ? parseFormat(opts.format) : defaultFormat(isTty);
  await emitText(formatValue(applySelect(value, opts.select), format, { pretty: isTty }), format, opts);
}

/** Writes already-formatted text to `--out` or stdout, neutralising terminal controls on a TTY. */
export async function emitText(formatted: string, format: Format, opts: EmitOptions = {}): Promise<void> {
  const isTty = Boolean(process.stdout.isTTY);
  let text = formatted;
  if (isTty && !opts.out) {
    if (format === 'table' || format === 'csv' || format === 'yaml') text = sanitizeForTerminal(text);
    else if (format === 'json' || format === 'jsonl') text = escapeJsonForTerminal(text);
  }
  if (opts.out) {
    writeOutFile(opts.out, text, {
      force: Boolean(opts.force),
      allowForce: Boolean(opts.allowForce),
      protectedDirs: protectedDirs(),
    });
    process.stderr.write(`hgi: wrote ${Buffer.byteLength(text)} bytes to ${opts.out}\n`);
    return;
  }
  await writeStream(process.stdout, text);
}
