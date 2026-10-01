import { main } from './cli.js';
import { ignoreEpipe } from './output/stdout.js';

ignoreEpipe(process.stdout, true);
ignoreEpipe(process.stderr, false);

main(process.argv).then((code) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
});
