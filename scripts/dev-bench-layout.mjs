/**
 * Run /dev/live-layout in headless Chromium and print the freeze numbers.
 *
 * NO NEW DEPENDENCY, same as scripts/dev-bench-chart.mjs: Node 22 ships a
 * global WebSocket, the Chrome DevTools Protocol is a WebSocket that takes
 * JSON, and this repo has no test runner to hang a browser driver off.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. That the paint loop survives a source
 * that changes size, that it survives an exception under BOTH painters, that a
 * run of layout switches reconfigures the capture track at most once, and that
 * the geometry and the preview box are the shapes they are meant to be — all
 * of that is a property of the code and is settled here.
 *
 * What is NOT settled: the COST. This container has no GPU and reports its own
 * `hardwareConcurrency`, so the capture-size decision it observes may not be
 * the decision a creator's laptop makes. The property under test is that the
 * decision happens at most once and never again, which is machine-independent.
 *
 * Console output is forwarded, because half of what this bench is about is
 * whether an exception was LOGGED once rather than per frame.
 *
 *   npm run build && node scripts/dev-bench-layout.mjs
 *   BASE=http://localhost:3000 node scripts/dev-bench-layout.mjs
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';

const BASE = process.env.BASE ?? 'http://localhost:3212';
const PORT = Number(new URL(BASE).port || 80);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9344);
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** The bench paints for ~1 minute on a slow box, plus the layout run. */
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

/** One CDP session: send a method, await its id, and surface console events. */
async function connect(wsUrl, onEvent) {
  const socket = new WebSocket(wsUrl);
  await once(socket, 'open');
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method) {
      onEvent?.(message);
      return;
    }
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

  const logs = [];
  try {
    if (!(await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20_000))) {
      throw new Error('chromium did not open its debugging port');
    }
    const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const cdp = await connect(version.webSocketDebuggerUrl);

    const { targetId } = await cdp.send('Target.createTarget', {
      url: `${BASE}/dev/live-layout?auto=1`,
    });
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = targets.find((t) => t.id === targetId);
    if (!page) throw new Error('the bench tab did not appear');

    /*
      THE CONSOLE IS EVIDENCE HERE, NOT NOISE.

      "an exception is caught, logged ONCE every five seconds, and the loop
      continues" is half the fix, and the only place the rate limit is visible
      is the log. `[composite] paint error` lines are counted below; an
      uncaught exception arrives as `Runtime.exceptionThrown` and is counted
      separately, because under the old code that is what a frozen broadcast
      left behind.
    */
    const tab = await connect(page.webSocketDebuggerUrl, (message) => {
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ');
        logs.push({ kind: message.params.type, text });
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        logs.push({
          kind: 'uncaught',
          text: details.exception?.description ?? details.text ?? 'uncaught',
        });
      }
    });
    await tab.send('Runtime.enable');

    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const { result } = await tab.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__layoutResult ?? null)',
        returnByValue: true,
      });
      const value = result.value ? JSON.parse(result.value) : null;
      if (value) {
        tab.close();
        cdp.close();
        return { ...value, logs };
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
  return [
    line(columns),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((row) => line(columns.map((column) => row[column] ?? '—'))),
  ].join('\n');
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

    console.log('\n=== L1/L2/L3: is the loop still painting? ===');
    console.log(
      table(result.frames, [
        'when',
        'painted',
        'paintErrors',
        'fps',
        'pictureDelta',
        'verdict',
      ]),
    );

    console.log('\n=== L3: how often the capture track was reconfigured ===');
    console.log(`  ${result.reconfigures}`);

    console.log("\n=== L4: the chart's rect at 1080p on a 2560x1440 monitor ===");
    console.log(
      table(result.rects, [
        'layout',
        'fit',
        'drawnAs',
        'slot',
        'sourceRead',
        'chartPixels',
        'panLeftEdges',
      ]),
    );

    const paintErrorLines = result.logs.filter((entry) =>
      entry.text.includes('[composite] paint error'),
    );
    const uncaught = result.logs.filter((entry) => entry.kind === 'uncaught');
    console.log('\n=== the console: caught, rate-limited, and nothing uncaught ===');
    console.log(`  [composite] paint error lines: ${paintErrorLines.length}`);
    for (const entry of paintErrorLines) console.log(`    ${entry.text.slice(0, 160)}`);
    console.log(`  uncaught exceptions: ${uncaught.length}`);
    for (const entry of uncaught.slice(0, 5)) console.log(`    ${entry.text.slice(0, 160)}`);
    for (const entry of result.logs.filter((e) => e.text.startsWith('[screen]'))) {
      console.log(`  ${entry.text.slice(0, 160)}`);
    }

    console.log('\n=== checks ===');
    for (const check of result.checks) {
      if (!check.pass) failures += 1;
      console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n        ${check.detail}`);
    }

    /*
      TWO ASSERTIONS THE PAGE CANNOT MAKE ABOUT ITSELF.

      A page can count the errors it caught; it cannot see the ones that
      escaped, and it cannot see how many console lines its own rate limiter
      actually emitted. Both are properties of the process, so both are checked
      here. The sabotage runs twice for a second each, so a five-second limiter
      may legitimately emit up to two lines per run — four is the ceiling, and
      anything approaching one-per-frame (24/s) is a limiter that is not
      limiting.
    */
    const rateLimited = paintErrorLines.length > 0 && paintErrorLines.length <= 4;
    if (!rateLimited) failures += 1;
    console.log(
      `  ${rateLimited ? 'PASS' : 'FAIL'}  paint errors are logged, and rate-limited to a handful` +
        `\n        ${paintErrorLines.length} lines for two 1s sabotage runs (want 1-4)`,
    );

    const nothingUncaught = uncaught.length === 0;
    if (!nothingUncaught) failures += 1;
    console.log(
      `  ${nothingUncaught ? 'PASS' : 'FAIL'}  no exception escaped the paint callback` +
        `\n        ${uncaught.length} uncaught`,
    );

    console.log(`\nfinished ${result.finishedAt}`);
  } finally {
    server?.kill('SIGKILL');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  }
}

await main();
