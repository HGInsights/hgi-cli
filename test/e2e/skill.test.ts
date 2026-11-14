import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, runCli, type Sandbox } from '../support/cli.js';
import { errorBody } from '../support/e2e.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox('http://127.0.0.1:9');
});
afterEach(() => sb.cleanup());

const skillFile = fs.readFileSync('skills/hgi/SKILL.md', 'utf8');

/** The text under `heading`, up to the next heading of the same or a higher level. */
function section(heading: string): string {
  const start = skillFile.indexOf(`\n${heading}\n`);
  expect(start, `missing heading: ${heading}`).toBeGreaterThanOrEqual(0);
  const level = heading.indexOf(' ');
  const lines = skillFile.slice(start + heading.length + 2).split('\n');
  let inFence = false;
  const end = lines.findIndex((line) => {
    if (line.startsWith('```')) inFence = !inFence;
    return !inFence && new RegExp(`^#{1,${level}} `).test(line);
  });
  return (end === -1 ? lines : lines.slice(0, end)).join('\n');
}

describe('SKILL.md (Story 10)', () => {
  it('has the frontmatter Claude Code needs for discovery', () => {
    const match = /^---\nname: hgi\ndescription: (.+)\n---\n/.exec(skillFile);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? '').length).toBeGreaterThan(40);
  });
  it('is auto-discoverable from the repo through .claude/skills', () => {
    expect(fs.lstatSync('.claude/skills/hgi').isSymbolicLink()).toBe(true);
    expect(fs.readFileSync('.claude/skills/hgi/SKILL.md', 'utf8')).toBe(skillFile);
  });
  it('states the rules: list tools first, call for lookups, ask before run, report credit cost, the allowlist', () => {
    expect(skillFile).toMatch(/List tools first[\s\S]*hgi tools list --json/);
    expect(skillFile).toMatch(/hgi call[\s\S]*lookups/);
    expect(skillFile).toMatch(/hgi run[\s\S]*only with the user's approval/i);
    expect(skillFile).toMatch(/Report the credit cost after every call/);
    expect(skillFile).toContain('"allow": ["Bash(hgi call *)"');
    expect(skillFile).toContain('"ask": ["Bash(hgi run *)"]');
  });
  it('documents every exit code the CLI can return', () => {
    for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(skillFile).toMatch(new RegExp(`\\| ${code} \\|`));
    }
  });
  it('warns agents that outcome_unknown applies to any exit code of a run', () => {
    expect(skillFile).toMatch(/outcome_unknown: true`, whatever its exit code \(1, 7 or 9\)/);
    expect(skillFile).toMatch(/\| 9 \|[^\n]*outcome_unknown/);
  });
  it('asks for a sample batch, its credit_cost and a plan, then waits for the go-ahead (Rule 7)', () => {
    const rule = /^7\. .*$/m.exec(section('## Rules'))?.[0] ?? '';
    expect(rule).toMatch(
      /one sample batch[\s\S]*`credit_cost`[\s\S]*the calls, the number of batches, and the total estimated by extrapolating from the sample[\s\S]*Wait for the user's go-ahead/,
    );
    expect(rule).toContain('never from a price list');
    expect(rule).toContain('labelled "observed"');
  });
  it('has a Recipes section with the shared preamble: tools check, schema batch size, cache, unknown not zero', () => {
    const recipes = section('## Recipes');
    const preamble = recipes.slice(0, recipes.indexOf('### '));
    expect(preamble).toMatch(/hgi tools list --json`\. If one is missing, skip that step and tell the user which tool is unavailable/);
    expect(preamble).toMatch(/Read `maxItems`[\s\S]*`input_schema`/);
    expect(preamble).toMatch(/30 days \(7 for search\)[\s\S]*\(observed\)[\s\S]*Sort ids and keep the same batches/);
    expect(preamble).toMatch(/Changing one id in a batch makes the whole batch a new input/);
    expect(preamble).toMatch(/unknown, not zero/);
  });
  describe.each(['### Match an account list', '### Score fit and propensity', '### Size wallet from spend'])('%s', (heading) => {
    it('opens with Tools (checked in the tool list), Batch (from maxItems) and Order, and has an example', () => {
      const recipe = section(heading);
      expect(recipe).toMatch(/\*\*Tools:\*\* [^\n]*hgi tools list --json`; if one is missing, skip that step and tell the user which tool is unavailable/);
      expect(recipe).toMatch(/\*\*Batch:\*\* read `maxItems` on `hg_ids`[^\n]*`input_schema`/);
      expect(recipe).toMatch(/\*\*Order:\*\*\n\n1\. /);
      expect(recipe).toMatch(/^hgi call \w+ --input /m);
    });
  });
  it('Match: search with HQ country and revenue floor, then batched firmographics, with the HQ caveat', () => {
    const recipe = section('### Match an account list');
    expect(recipe).toMatch(/1\. `search_companies`[^\n]*HQ country and a revenue floor/);
    expect(recipe).toMatch(/2\. [^\n]*`company_firmographic` in batches of `hg_ids`/);
    expect(recipe).toMatch(/Don't roll up to the global HQ[^\n]*Legrand Lebanon as Legrand's global HQ, and the French state as EDF's parent/);
  });
  it('Score: safe paging, intent on the web domain, the observed baseline, the 422 and filtered summaries', () => {
    const recipe = section('### Score fit and propensity');
    expect(recipe).toMatch(/1\. \*\*Fit:\*\*[^\n]*with `--all-pages`/);
    expect(recipe).toMatch(/stops on a short page or `total_installs_count`, not on `has_more` alone/);
    expect(recipe).toMatch(/`truncated: true` is partial: say so/);
    expect(recipe).toMatch(/`company_intent` on the company's web domain[^\n]*Accor had 0 topics on its HQ id and 18 on `accor\.com` \(observed/);
    expect(recipe).toMatch(/about 70% of the ~20,000-topic catalogue \(observed\)/);
    expect(recipe).toMatch(/A summary with `topic_ids` counts only those topics/);
    expect(recipe).toMatch(/`fields:\["summary"\]` without a topic filter rejects `granularity` \(422\)/);
    expect(recipe).toMatch(/`fields:\["topics"\]`, pass `granularity:"global"`/);
  });
  it('Score: the example pages with --all-pages, capped, with the page size from the schema', () => {
    const block = /```bash\n([\s\S]*?)```/.exec(section('### Score fit and propensity'))?.[1] ?? '';
    expect(block).toMatch(/hgi call company_technographic --all-pages --max-pages \d+/);
    expect(block).toMatch(/"max_results":<schema maximum>/);
    expect(block).not.toMatch(/"offset"/);
    expect(block).toMatch(/details\.partial_result/);
  });
  it('Paging: tells agents to use --all-pages, that each page is billed, and what truncated means', () => {
    const paging = section('### Paging (`--all-pages`)');
    expect(paging).toMatch(/instead of an `offset` loop/);
    expect(paging).toMatch(/\*\*Each extra page is a separate, billed call\.\*\*/);
    expect(paging).toMatch(/never on `has_more: true` alone/);
    expect(paging).toMatch(/`truncated_reason`: `max_pages`, `unmatched`/);
    expect(paging).toMatch(/`not_pageable`/);
  });
  it('takes limits from the schema, never quoting a number for them', () => {
    const recipes = section('## Recipes');
    expect(recipes).not.toMatch(/currently \d/);
    expect(recipes).not.toMatch(/"max_results":\s*\d/);
  });
  it('Spend: resolve category ids first, pass them in the batched call, never add a parent to its children', () => {
    const recipe = section('### Size wallet from spend');
    expect(recipe).toMatch(/2\. [^\n]*resolve its category ids first with `get_product_category`/);
    expect(recipe).toMatch(/3\. One `company_spend` call per batch of `hg_ids`, with `category_ids` set in that same call/);
    expect(recipe).toMatch(/`category_parent_id`[^\n]*never a parent with its children/);
  });
  it('has a Data semantics row per tool with its default scope and the meaning of its nulls', () => {
    const semantics = section('## Data semantics');
    const unknownCell = 'no field came back null in the verification call; treat a missing field as unknown';
    const rows: [string, RegExp][] = [
      ['search_companies', new RegExp(`^\\| \`search_companies\` \\| global: [^|]*\\| ${unknownCell} \\|$`, 'm')],
      ['company_firmographic', /^\| `company_firmographic` \| country: [^|]*\| `corporate_parent_id`, `corporate_parent_name`, `parent_id`, `domestic_parent_id`, `domestic_parent_name`: none [^|]*; `fortune_500_rank`, `forbes_2000_rank`: unknown \|$/m],
      ['company_technographic', /^\| `company_technographic` \| global: default rows have `country_code: null`[^|]*\| `country_code`: a global or unattributed row[^|]*`product_category_level4_name`, `product_category_level5_name`: none [^|]*\|$/m],
      ['company_intent', new RegExp(`^\\| \`company_intent\` \\| global: \`summary\` only[^|]*one row per state unless \`granularity:"global"\` \\| ${unknownCell} \\|$`, 'm')],
      ['company_spend', new RegExp(`^\\| \`company_spend\` \\| country: [^|]*\\| ${unknownCell} \\|$`, 'm')],
    ];
    for (const [tool, row] of rows) expect(semantics, tool).toMatch(row);
    expect(semantics).toMatch(/left-pad them to 32 with `0` before comparing/);
    expect(semantics).toMatch(/leading zero dropped, as 31 characters/);
  });
  it('is shipped in the npm package', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('skills');
  });
});

describe('release notes', () => {
  it('tell skill users to run `hgi skill install --force`, rendered literally by the workflow heredoc', () => {
    const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
    const block = /\n( *)cat > notes\.md <<EOF\n([\s\S]*?)\n\1EOF\n/.exec(workflow);
    expect(block, 'notes heredoc not found').not.toBeNull();
    const indent = block?.[1] ?? '';
    const body = (block?.[2] ?? '')
      .split('\n')
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
      .join('\n');
    // Render it the way the workflow does, unquoted. A fake `hgi` first on PATH and a sandboxed
    // HOME make sure an unescaped backtick can never run the real CLI against a real home.
    const bin = path.join(sb.dir, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(sb.dir, 'hgi-was-run');
    fs.writeFileSync(path.join(bin, 'hgi'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const res = spawnSync('bash', ['-euo', 'pipefail', '-c', `cat > notes.md <<EOF\n${body}\nEOF\n`], {
      cwd: sb.dir,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: sb.dir,
        CLAUDE_CONFIG_DIR: path.join(sb.dir, 'claude'),
        XDG_CONFIG_HOME: path.join(sb.dir, 'xdg'),
        TAG: 'v9.9.9',
        REPO: 'example/repo',
      },
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(sb.dir, 'notes.md'), 'utf8')).toContain(
      'If you installed the agent skill with `hgi skill install`, run `hgi skill install --force` after upgrading to get the current version.',
    );
  });
});

describe('hgi skill install', () => {
  it('installs, is idempotent, and refuses to clobber a different file without --force', async () => {
    const dir = path.join(sb.dir, 'skills');
    const first = await runCli(['skill', 'install', '--dir', dir], sb.env);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).result).toBe('installed');
    expect(fs.readFileSync(path.join(dir, 'hgi', 'SKILL.md'), 'utf8')).toBe(skillFile);
    expect(JSON.parse((await runCli(['skill', 'install', '--dir', dir], sb.env)).stdout).result).toBe('unchanged');

    fs.writeFileSync(path.join(dir, 'hgi', 'SKILL.md'), 'local edits');
    const clash = await runCli(['skill', 'install', '--dir', dir], sb.env);
    expect(clash.code).toBe(2);
    expect(errorBody(clash).error.details?.reason).toBe('exists');
    expect(fs.readFileSync(path.join(dir, 'hgi', 'SKILL.md'), 'utf8')).toBe('local edits');
    const forced = await runCli(['skill', 'install', '--dir', dir, '--force'], sb.env);
    expect(JSON.parse(forced.stdout).result).toBe('replaced');
    expect(fs.readFileSync(path.join(dir, 'hgi', 'SKILL.md'), 'utf8')).toBe(skillFile);
  });
  it('defaults to ~/.claude/skills and honors CLAUDE_CONFIG_DIR', async () => {
    const res = await runCli(['skill', 'install'], sb.env);
    expect(res.code, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(sb.dir, '.claude', 'skills', 'hgi', 'SKILL.md'))).toBe(true);
    const custom = path.join(sb.dir, 'claude-cfg');
    await runCli(['skill', 'install'], { ...sb.env, CLAUDE_CONFIG_DIR: custom });
    expect(fs.existsSync(path.join(custom, 'skills', 'hgi', 'SKILL.md'))).toBe(true);
  });
  it('refuses to install through a symlink', async () => {
    const real = path.join(sb.dir, 'real');
    fs.mkdirSync(real);
    const link = path.join(sb.dir, 'linked-skills');
    fs.symlinkSync(real, link);
    const res = await runCli(['skill', 'install', '--dir', link], sb.env);
    expect(res.code).toBe(2);
    expect(fs.readdirSync(real)).toEqual([]);
  });
});
