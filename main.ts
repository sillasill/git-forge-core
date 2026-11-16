// Entry lifecycle: bind a port, tell the trial env about it, wait until the
// env says the trial is over, then exit. The env drives everything from
// then on; this file only speaks the small wire protocol below.
//
//   MAKEFUN_ENV_URL is the env origin (http://store:8080 inside a trial
//   container). With no env to talk to, exit 1 immediately.
//   The server listens on port 0 so the kernel picks a free one. Never
//   bind 8080: the env owns it.
//   POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the
//   request's source address plus N as this entry's base URL and dials
//   it from then on. The first register wins; a 409 means another entry
//   already registered, and this process just keeps waiting.
//   GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//   answers at once ({"done": false} while the suite runs), so this is a
//   poll, not a long-held request. A failed or slow poll is retried with
//   a short exponential backoff; the process never exits before done.
//   Close the server and exit 0. The harness then stops the env, which
//   writes the export the scorer reads.
//
// Only the app server is imported here: no packages, no Node built-ins
// beyond what the server itself uses, no model calls.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request may take this long before it is abandoned.
const TIMEOUT_MS = 30_000;
// Retry waits start here and never grow past the cap below.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Wait after `failures` failed requests: exponential from the start, capped.
function backoff(failures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

// POST the bound port until the env accepts it. 200 is the normal answer;
// 409 means a first register already won, which is not ours to fix. 400
// and 405 are contract errors and end the program; a network error or any
// other status is retried, since the env may still be starting.
async function registerWithEnv(port: number): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoff(failures));
    failures += 1;
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done yet.
    }
    await pause(backoff(failures));
    failures += 1;
  }
}

// Bind the port, register it, then wait for the env: the whole life of this process.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerWithEnv(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
