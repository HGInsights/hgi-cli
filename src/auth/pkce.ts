import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

export function challengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
