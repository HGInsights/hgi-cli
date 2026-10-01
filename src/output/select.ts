import { HgiError } from '../errors.js';

type Trie = Map<string, Trie | true>;

export function parseSelect(raw: string): Trie {
  const trie: Trie = new Map();
  const paths = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length === 0) {
    throw new HgiError('invalid_input', '--select needs at least one field name.', {
      details: { reason: 'empty_select' },
    });
  }
  for (const p of paths) {
    const parts = p.split('.');
    let node = trie;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const existing = node.get(part);
      if (last) {
        node.set(part, true);
      } else if (existing === true) {
        // a shorter path already selects the whole subtree
      } else {
        const child: Trie = existing ?? new Map();
        node.set(part, child);
        node = child;
      }
    });
  }
  return trie;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function project(node: unknown, trie: Trie): unknown {
  if (Array.isArray(node)) return node.map((item) => project(item, trie));
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, sub] of trie) {
    if (!(key in node)) continue;
    out[key] = sub === true ? node[key] : project(node[key], sub);
  }
  return out;
}

export function applySelect(value: unknown, raw: string | undefined): unknown {
  if (raw === undefined) return value;
  return project(value, parseSelect(raw));
}
