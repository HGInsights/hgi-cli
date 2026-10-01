const secrets = new Set<string>();

const MIN_SECRET_LENGTH = 8;
const MASK = '[REDACTED]';

const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`],
  [
    /("?(?:access_token|refresh_token|code_verifier|client_secret)"?\s*[:=]\s*)("[^"]*"|[^\s&,}]+)/gi,
    `$1"${MASK}"`,
  ],
  [/([?&](?:code|code_verifier|access_token|refresh_token)=)[^&\s"']+/gi, `$1${MASK}`],
];

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
}

export function clearSecrets(): void {
  secrets.clear();
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join(MASK);
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}
