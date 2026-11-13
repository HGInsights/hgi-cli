// What `hgi auth login` tells a user whose sign-in page ends on "403 Forbidden". A browser with no
// session on the server can be refused after its first sign-in step; a private window that signs in
// at the server first gets past it, and the loopback listener is still waiting. Keep README.md →
// "Troubleshooting" in step with this wording (test/unit/recovery.test.ts checks the README entry).

function steps(base: string, browser: 'this browser' | 'that browser'): string {
  const host = new URL(base).host;
  return `open a private window (or clear ${browser}'s cookies for ${host}), sign in at ${base} first`;
}

/** The lines printed before the browser opens in the default flow. */
export function browserFlowLines(base: string, url: string): string[] {
  return [
    'Opening your browser to sign in. If it does not open, or the page shows an error,',
    'open this URL in a browser on this computer; sign-in still finishes here:',
    `  ${url}`,
    `If the page shows 403 Forbidden: ${steps(base, 'this browser')}, then open the URL above in that same window.`,
  ];
}

/** The 403 line for `--no-browser`, where the browser may be on another machine. */
export function noBrowserForbiddenLine(base: string): string {
  return `If the page shows 403 Forbidden, in the browser you open it in: ${steps(base, 'that browser')}, then open the URL above in that same window.`;
}

/** The hint on the login-timeout error. */
export function loginTimeoutHint(base: string): string {
  return (
    `If the sign-in page showed 403 Forbidden: ${steps(base, 'that browser')}, ` +
    'then run `hgi auth login` again and open the URL it prints in that same window. ' +
    'On a remote machine, use `--no-browser`.'
  );
}
