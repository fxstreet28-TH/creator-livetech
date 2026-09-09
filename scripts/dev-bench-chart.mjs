/**
 * Run /dev/live-chart in headless Chromium and print the โหมดกราฟ numbers.
 *
 * NO NEW DEPENDENCY, same as scripts/dev-bench-dualcam.mjs: Node 22 ships a
 * global WebSocket, the Chrome DevTools Protocol is a WebSocket that takes
 * JSON, and this repo has no test runner to hang a browser driver off.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. The composite geometry, the crop, the
 * pan, the contentHint and the encoder PARAMETERS are properties of the code
 * and are settled here. Three things are NOT:
 *
 *   THE COST. This container has no GPU, so the rasterizer and the encoder are
 *   both software and both several times slower than a creator's laptop. Read
 *   the ratios between rungs; read the milliseconds as an upper bound. The F6
 *   ship gate is applied against these numbers deliberately — a rung with no
 *   margin on the pessimistic bench has none to spare on the real machine.
 *
 *   THE CODEC. Chromium's headless build here has no H.264 encoder, so
 *   `preferH264` finds nothing to prefer and the loopback negotiates VP8. What
 *   the bench measures about RESOLUTION is unaffected — `degradationPreference`
 *   and `scaleResolutionDownBy` are handled by WebRTC's adaptation layer above
 *   the codec — but a bitrate or an artefact seen here is a VP8 one, and
 *   production publishes H.264.
 *
 *   THE UPLINK. A loopback has no congestion to discover, so the bandwidth
 *   estimator ramps from its own floor and `qualityLimitationReason:
 *   'bandwidth'` can never appear. Its absence here says nothing about a
 *   creator's network; 'cpu', which CAN appear, is the limitation that silently
 *   halved a chart under `maintain-framerate`.
 *
 *   npm run build && node scripts/dev-bench-chart.mjs
 *   BASE=http://localhost:3000 node scripts/dev-bench-chart.mjs
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';

const BASE = process.env.BASE ?? 'http://localhost:3211';
const PORT = Number(new URL(BASE).port || 80);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9343);
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** The bench paints and encodes for ~2 minutes on a slow box. */
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 420_000);

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
      '--window-size=1440,900',
      'about:blank',
    ],
    // Chromium's stderr in a container is a wall of dbus, socket and TLS
    // complaints that have nothing to do with this bench.
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  try {
    if (!(await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20_000))) {
      throw new Error('chromium did not open its debugging port');
    }
    const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const cdp = await connect(version.webSocketDebuggerUrl);

    const { targetId } = await cdp.send('Target.createTarget', {
      url: `${BASE}/dev/live-chart?auto=1`,
    });
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = targets.find((t) => t.id === targetId);
    if (!page) throw new Error('the bench tab did not appear');
    const tab = await connect(page.webSocketDebuggerUrl);
    await tab.send('Runtime.enable');

    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const { result } = await tab.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__chartResult ?? null)',
        returnByValue: true,
      });
      const value = result.value ? JSON.parse(result.value) : null;
      if (value) {
        tab.close();
        cdp.close();
        return value;
      }
      if (Date.now() > deadline) throw new Error('the bench did not finish in time');
      await sleep(1_000);
    }
  } finally {
    chrome.kill('SIGKILL');
  }
}

function table(rows, columns) {
  if (rows.length === 0) return '  (none)';
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? '—').length)),
  );
  const line = (cells) => '  ' + cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map((row) =>
    line(columns.map((column) => row[column] ?? '—')),
  )].join('\n');
}

async function main() {
  let server = null;
  if (!process.env.BASE) {
    server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (!(await waitForHttp(BASE, 90_000))) {
      server.kill('SIGKILL');
      throw new Error(`next start did not come up on ${BASE} — run \`npm run build\` first`);
    }
  }

  let failures = 0;
  try {
    const result = await runBench();

    console.log('\n=== D1: what the encoder is actually sending ===');
    console.log(
      table(result.encoder, [
        'label',
        'canvas',
        'sending',
        'fps',
        'ceilingMbps',
        'degradation',
        'scaleDown',
        'kbps',
        'qualityLimitationReason',
        'encoder',
        'codec',
      ]),
    );

    console.log('\n=== D2/D3: chart pixels and resamples ===');
    console.log(
      table(result.scales, [
        'when',
        'quality',
        'layout',
        'monitor',
        'captured',
        'sourceRead',
        'slot',
        'scale',
        'resamples',
        'chartPixels',
      ]),
    );

    console.log('\n=== paint against the frame budget ===');
    console.log(
      table(result.paint, [
        'when',
        'quality',
        'canvas',
        'mode',
        'paintP50',
        'paintP95',
        'frameBudgetMs',
        'ofBudget',
        'fps',
      ]),
    );

    console.log(`\n=== F6: the 1440p rung ===\n  ${result.rung1440}`);

    console.log('\n=== checks ===');
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
