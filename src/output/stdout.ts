import { once } from 'node:events';

export async function writeStream(stream: NodeJS.WriteStream, text: string): Promise<void> {
  try {
    if (!stream.write(text)) await once(stream, 'drain');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
    throw err;
  }
}

export function ignoreEpipe(stream: NodeJS.WriteStream, exitOnEpipe: boolean): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      if (exitOnEpipe) process.exit(0);
      return;
    }
    throw err;
  });
}
