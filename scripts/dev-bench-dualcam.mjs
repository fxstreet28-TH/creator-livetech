/**
 * Run /dev/live-dualcam in headless Chromium and fail the shell on a red check.
 *
 * NO NEW DEPENDENCY. Node 22 ships a global WebSocket, and the Chrome DevTools
 * Protocol is a WebSocket that takes JSON — so driving a browser here is about
 * sixty lines rather than a Playwright install, and this repo has no test
 * runner to hang one off. The three things it needs are `Runtime.evaluate`,
 * a navigation and a poll.
 *
 * WHAT THE FAKE CAMERAS DO AND DO NOT PROVE.
 * `--use-fake-device-for-media-stream=device-count=2` gives Chromium two
 * synthetic cameras that will both open at once, so the probe reaches Tier 1
 * and its happy path — open the second, count frames out of both, mount — is
 * exercised end to end. That is worth having and it is NOT evidence about
 * iOS: Safari hands out one active camera at a time on most iPhones, which is
 * precisely why the probe exists. Tier 2 is exercised by the same run reading
 * `device-count=1`, where the probe must answer 'unavailable' and leave the
 * one camera alive.
 *
 *   node scripts/dev-bench-dualcam.mjs            # after `npm run build`
 *   BASE=http://localhost:3000 node scripts/...   # against a server already up
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';

const BASE = process.env.BASE ?? 'http://localhost:3210';
const PORT = Number(new URL(BASE).port || 80);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const CHROME =
  process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** The bench opens cameras and paints for ~12s; a slow CI box gets three times that. */
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000);

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

/** Launch Chromium with N fake cameras, run the bench, return its JSON. */
async function runBench(deviceCount) {
  const port = CDP_PORT + deviceCount;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--no-sandbox',
      '--disable-gpu',
      '--use-fake-ui-for-media-stream',
      `--use-fake-device-for-media-stream=device-count=${deviceCount}`,
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=420,900',
      'about:blank',
    ],
    // Chromium's stderr in a container is a wall of dbus, socket and TLS
    // complaints that have nothing to do with this bench and would bury its
    // output. Discarded on purpose: what this script cares about is whether
    // the debugging port opens, which the next few lines find out directly.
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  try {
    if (!(await waitForHttp(`http://127.0.0.1:${port}/json/version`, 20_000))) {
      throw new Error('chromium did not open its debugging port');
    }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const cdp = await connect(version.webSocketDebuggerUrl);

    // A fresh tab, so the bench never shares a page with about:blank's state.
    const { targetId } = await cdp.send('Target.createTarget', {
      url: `${BASE}/dev/live-dualcam?auto=1`,
    });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.id === targetId);
    if (!page) throw new Error('the bench tab did not appear');
    const tab = await connect(page.webSocketDebuggerUrl);
    await tab.send('Runtime.enable');

    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const { result } = await tab.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__dualcamResult ?? null)',
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
    // Two cameras: the composite checks, and the probe's Tier 1 happy path.
    // One camera: the probe must say 'unavailable' and leave it alive.
    for (const deviceCount of [2, 1]) {
      const result = await runBench(deviceCount);
      console.log(`\n=== ${deviceCount} fake camera(s) ===`);
      console.log(`probe: ${result.probe}`);
      for (const check of result.checks) {
        if (!check.pass) failures += 1;
        console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n        ${check.detail}`);
      }
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
