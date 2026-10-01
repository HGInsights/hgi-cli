import { HgiError } from '../errors.js';
import { registerSecret } from '../redact.js';
import { safeEqual } from './pkce.js';

export interface CallbackExpectation {
  redirectUri: string;
  state: string;
}

export function evaluateCallbackParams(params: URLSearchParams, expectedState: string): string {
  const states = params.getAll('state');
  const state = states.length === 1 ? states[0] : undefined;
  if (state === undefined || !safeEqual(state, expectedState)) {
    throw new HgiError('oauth_error', 'Sign-in response had a missing or mismatched state; it was rejected.', {
      hint: 'Run `hgi auth login` again and use the URL it prints.',
      details: { reason: 'state_mismatch' },
    });
  }
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description');
    throw new HgiError(
      'oauth_error',
      error === 'access_denied'
        ? 'Sign-in was denied or cancelled.'
        : `Sign-in failed: ${error}${description ? ` (${description})` : ''}.`,
      { details: { reason: error } },
    );
  }
  const codes = params.getAll('code');
  const code = codes.length === 1 ? codes[0] : undefined;
  if (!code) {
    throw new HgiError('oauth_error', 'Sign-in response did not include exactly one authorization code.', {
      details: { reason: 'missing_code' },
    });
  }
  registerSecret(code);
  return code;
}

export function parsePastedCallback(input: string, expected: CallbackExpectation, used: { value: boolean }): string {
  if (used.value) {
    throw new HgiError('oauth_error', 'This callback URL was already used.', {
      details: { reason: 'callback_reused' },
    });
  }
  let url: URL;
  let want: URL;
  try {
    url = new URL(input.trim());
    want = new URL(expected.redirectUri);
  } catch {
    throw new HgiError('oauth_error', 'That is not a valid callback URL.', {
      hint: 'Paste the full URL from the browser address bar after approving.',
      details: { reason: 'invalid_url' },
    });
  }
  if (
    url.protocol !== want.protocol ||
    url.hostname !== want.hostname ||
    url.port !== want.port ||
    url.pathname !== want.pathname ||
    url.username ||
    url.password
  ) {
    throw new HgiError('oauth_error', 'The pasted URL does not match the redirect URI this login started with.', {
      hint: `Expected it to start with ${expected.redirectUri}`,
      details: { reason: 'redirect_mismatch' },
    });
  }
  used.value = true;
  return evaluateCallbackParams(url.searchParams, expected.state);
}
