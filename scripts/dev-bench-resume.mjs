/**
 * Run /dev/live-resume in headless Chromium and fail the shell on a red check.
 *
 * NO NEW DEPENDENCY, for the same reason scripts/dev-bench-dualcam.mjs has
 * none: Node 22 ships a global WebSocket, the Chrome DevTools Protocol is a
 * WebSocket that takes JSON, and this repo has no test runner to hang a browser
 * driver off. Navigation, `Runtime.evaluate`, a poll.
 *
 * WHAT THE FLAGS BUY. `--autoplay-policy=no-user-gesture-required` is what lets
 * the player's play() succeed without a click, which is the ONE thing this
 * bench deliberately does not test — an iPhone's autoplay refusal after a
 * resume is not reproducible here, and the tap path is exercised by clicking
 * the overlay directly instead. No fake camera flags: the WHEP side needs no
 * camera at all (the origin is a canvas inside the page) and the publisher
 * check builds its tracks the same way.
 *
 *   node scripts/dev-bench-resume.mjs            # after `npm run build`
 *   BASE=http://localhost:3000 node scripts/...  # against a server already up
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';

const BASE = process.env.BASE ?? 'http://localhost:3211';
const PORT = Number(new URL(BASE).port || 80);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9344);
const CHROME =
  process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** The bench negotiates several WebRTC sessions and waits out two watchdogs. */
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 240_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

/** One CDP session: send a method, await its id. Enough for this job. */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await once(socket, 'open');
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
}

async function runBench() {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-sandbox',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=420,900',
      'about:blank',
    ],
    // Chromium's stderr in a container is a wall of dbus, socket and TLS
    // complaints unrelated to this bench, and it would bury the output. What
    // matters is whether the debugging port opens, which is checked directly.
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  try {
    if (!(await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20_000))) {
      throw new Error('chromium did not open its debugging port');
    }
    const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const cdp = await connect(version.webSocketDebuggerUrl);

    const { targetId } = await cdp.send('Target.createTarget', {
      url: `${BASE}/dev/live-resume?auto=1`,
    });
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = targets.find((t) => t.id === targetId);
    if (!page) throw new Error('the bench tab did not appear');
    const tab = await connect(page.webSocketDebuggerUrl);
    await tab.send('Runtime.enable');

    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const { result } = await tab.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__resumeResult ?? null)',
        returnByValue: true,
      });
      const value = result.value ? JSON.parse(result.value) : null;
      if (value) {
        tab.close();
        cdp.close();
        return value;
      }
      if (Date.now() > deadline) throw new Error('the bench did not finish in time');
      await sleep(500);
    }
  } finally {
    chrome.kill('SIGKILL');
  }
}

async function main() {
  let server = null;
  if (!process.env.BASE) {
    server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (!(await waitForHttp(BASE, 60_000))) {
      server.kill('SIGKILL');
      throw new Error(`next start did not come up on ${BASE} — run \`npm run build\` first`);
    }
  }

  let failures = 0;
  try {
    const result = await runBench();
    for (const check of result.checks) {
      if (!check.pass) failures += 1;
      console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n        ${check.detail}`);
    }
  } finally {
    server?.kill('SIGKILL');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
