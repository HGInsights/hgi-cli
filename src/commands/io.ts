export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function stderrWantsJson(): boolean {
  return !process.stderr.isTTY || process.argv.includes('--json-errors');
}

/** One credit line on stderr: `credit_cost: 3`, or `{"credit_cost":3}` when stderr is not a terminal. */
export function reportCredit(cost: number | null): void {
  process.stderr.write(stderrWantsJson() ? `${JSON.stringify({ credit_cost: cost })}\n` : `credit_cost: ${cost ?? 'unknown'}\n`);
}
