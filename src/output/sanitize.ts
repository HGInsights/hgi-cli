// Terminal escape sequences in third-party text (web results, filings, reviews) can rewrite the
// screen, retitle the window or write the clipboard (OSC 52); a bare carriage return can overwrite a
// line; bidirectional overrides can reorder what the eye reads. Neutralise them before a TTY sees them.
// Invisible formatting characters that can reorder or disguise text. U+200C/U+200D (joiners) are left
// alone: emoji sequences and several scripts need them.
function isBidi(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200b ||
    (code >= 0x200e && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

function isC1(code: number): boolean {
  return code >= 0x7f && code <= 0x9f;
}

function visible(code: number): string {
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
}

export function sanitizeForTerminal(text: string): string {
  let out = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0d) {
      out += chars[i + 1] === '\n' ? ch : visible(code);
    } else if (code === 0x09 || code === 0x0a) {
      out += ch;
    } else if (code <= 0x1f || isC1(code) || isBidi(code)) {
      out += visible(code);
    } else {
      out += ch;
    }
  }
  return out;
}

// JSON text already escapes C0 controls natively. C1 controls (U+009B is a single-byte CSI) and
// bidi overrides pass through JSON.stringify, but they can only occur inside strings, so rewriting them
// as \uXXXX escapes keeps the document valid and the value identical.
export function escapeJsonForTerminal(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += isC1(code) || isBidi(code) ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}
