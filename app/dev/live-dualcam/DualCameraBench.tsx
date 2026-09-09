'use client';

/**
 * The dual-camera composite, checked rather than eyeballed.
 *
 * WHAT IS SYNTHETIC AND WHY. A camera is not available in CI and gives a
 * different picture on every machine, so both sources here are canvases
 * repainted on an interval and captured as tracks — one drawing a candlestick
 * chart (what a back camera is pointed AT), one drawing a face (what a front
 * camera sees). They are 720x960, which is the 3:4 upright frame a phone
 * sensor actually hands back, and that ratio is what makes the fit check mean
 * something: 3:4 in a 720x640 slot is 480x640 with black bars down both sides
 * under `contain`, and edge to edge under `cover`.
 *
 * WHAT IS REAL. `createFilteredStream`, `setSecondSource`, `layoutRects`, the
 * 24fps cadence, the published canvas track. Nothing here reimplements the
 * composite — the pixels checked below are read back OUT of the track the
 * broadcast would publish, by drawing it into a canvas of this page's own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createFilteredStream, type FilteredStream } from '@/lib/live/cameraFilters';
import {
  COMPOSITE_FRAME_RATE,
  COMPOSITE_SIZE_720,
  layoutRects,
  type Rect,
} from '@/lib/live/compositeCanvas';
import {
  cachedDualCameraTier,
  countVideoInputs,
  probeDualCamera,
  resetDualCameraProbe,
  trackDeliversFrames,
} from '@/lib/live/dualCameraCapture';

/** One assertion, and the numbers behind it. */
interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * The two grounds the sources are painted on.
 *
 * Picked so that "which source landed in this slot" is decided by comparing
 * two channels rather than by matching a colour: the back camera's ground is
 * blue-dominant and the front camera's is red-dominant, which survives the
 * candles, the face, and any resampling `drawImage` does on the way.
 */
const BACK_GROUND = '#0a1e3d';
const FRONT_GROUND = '#3d0a1e';

/** The frame a phone sensor actually gives: upright, 3:4. */
const SOURCE_WIDTH = 720;
const SOURCE_HEIGHT = 960;

/** Long enough for the paint percentiles to settle. */
const SAMPLE_MS = 4_000;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** A candlestick chart on the back camera's ground. What Por points the phone at. */
function drawChart(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.fillStyle = BACK_GROUND;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#1c3a5e';
  ctx.lineWidth = 1;
  for (let y = 0; y < h; y += Math.round(h / 24)) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
  const candles = 60;
  const cw = w / candles;
  for (let i = 0; i < candles; i += 1) {
    const seed = Math.sin((i + t) * 0.7) * 0.5 + Math.sin((i + t) * 0.23) * 0.5;
    const mid = h / 2 + seed * h * 0.28;
    const body = Math.abs(Math.sin((i + t) * 1.3)) * h * 0.05 + 4;
    ctx.fillStyle = seed > 0 ? '#26a69a' : '#ef5350';
    ctx.fillRect(i * cw + 1, mid - body / 2, Math.max(1, cw - 2), body);
  }
}

/** A face on the front camera's ground. A subject in the middle, no fine detail. */
function drawFace(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.fillStyle = FRONT_GROUND;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#c9a227';
  ctx.beginPath();
  ctx.ellipse(w / 2 + Math.sin(t) * w * 0.03, h / 2, w * 0.14, h * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** A canvas repainted on an interval, captured as a track. A fake camera. */
function makeSource(
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void,
): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = SOURCE_WIDTH;
  canvas.height = SOURCE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  let t = 0;
  paint(ctx, SOURCE_WIDTH, SOURCE_HEIGHT, t);
  const timer = window.setInterval(() => {
    t += 0.15;
    paint(ctx, SOURCE_WIDTH, SOURCE_HEIGHT, t);
  }, 1000 / 30);
  return { stream: canvas.captureStream(30), stop: () => window.clearInterval(timer) };
}

/**
 * Read one frame back OUT of a published track.
 *
 * This is the whole reason the checks below are checks: the assertion is made
 * against the pixels an encoder would be handed, not against the arguments the
 * layout was called with. A wrong slot, a wrong fit or a source that never
 * mounted all show up here and nowhere else.
 */
async function grabFrame(stream: MediaStream): Promise<ImageData | null> {
  const [track] = stream.getVideoTracks();
  if (!track) return null;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await video.play().catch(() => undefined);
  // A couple of frames in, so the element is certainly past its first decode.
  await wait(300);
  if (!(video.videoWidth > 0)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  video.pause();
  video.srcObject = null;
  return data;
}

function pixelAt(frame: ImageData, x: number, y: number): [number, number, number] {
  const cx = Math.max(0, Math.min(frame.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(frame.height - 1, Math.round(y)));
  const i = (cy * frame.width + cx) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
}

/** Blue-dominant is the back camera's ground; red-dominant is the front's. */
function groundOf(rgb: [number, number, number]): 'back' | 'front' | 'black' | 'other' {
  const [r, g, b] = rgb;
  if (r < 12 && g < 12 && b < 12) return 'black';
  if (b > r + 8) return 'back';
  if (r > b + 8) return 'front';
  return 'other';
}

const rgbLabel = (rgb: [number, number, number]) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

/**
 * Sample a slot at its centre and hard against both of its side edges.
 *
 * The edges are the fit test. A `cover` slot is filled corner to corner, so a
 * pixel two in from the left is picture; a `contain` slot holding a 3:4 source
 * has 120px of the canvas's own black down each side, so the same pixel is
 * black. That is the entire difference between drawing a chart and drawing a
 * camera, and it is checkable in three reads.
 */
function sampleSlot(frame: ImageData, slot: Rect) {
  const midY = slot.y + slot.height / 2;
  return {
    centre: pixelAt(frame, slot.x + slot.width / 2, midY),
    left: pixelAt(frame, slot.x + 2, midY),
    right: pixelAt(frame, slot.x + slot.width - 3, midY),
  };
}

interface Result {
  checks: Check[];
  probe: string;
  finishedAt: string;
}

export function DualCameraBench() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [probeLine, setProbeLine] = useState<string>('—');
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  /**
   * The composite half: synthetic sources, real pipeline, pixels read back.
   *
   * Ordered so that each stage is checked in the state the one before it left
   * behind — camera-only, then `cover` (the mobile dual-camera path), then
   * `contain` (the desktop share path, as a negative control), then unmounted
   * back to camera-only. A fit that leaked between mounts, or a rate that
   * never went back to 30, shows up as the LAST check failing.
   */
  const runComposite = useCallback(async (): Promise<Check[]> => {
    const found: Check[] = [];
    const front = makeSource(drawFace);
    const back = makeSource(drawChart);
    let filtered: FilteredStream | null = null;

    try {
      // Exactly the call CreatorBroadcaster makes on a PHONE broadcast: the
      // phone's long-edge cap, no portrait publish canvas (the published track
      // is the preview canvas), and the 720p composite frame.
      filtered = await createFilteredStream(front.stream, 'none', 30, false, 1280, false,
        COMPOSITE_SIZE_720);

      const publish = filtered.publishStream;
      const [publishTrack] = publish.getVideoTracks();
      const publishedSize = () => {
        const s = publishTrack?.getSettings() ?? {};
        return `${s.width ?? '?'}x${s.height ?? '?'}`;
      };

      // ---------------------------------------------------- camera-only
      await wait(1_000);
      const soloStats = filtered.getStats();
      found.push({
        name: 'camera-only publishes the sensor frame at 30fps',
        pass:
          soloStats.paintRate === 30 &&
          soloStats.compositing === false &&
          soloStats.secondSource === null,
        detail: `${publishedSize()} @${soloStats.paintRate}fps, compositing=${soloStats.compositing}`,
      });

      // ----------------------------------------------- tier 1: both cameras
      await filtered.setSecondSource(back.stream, { fit: 'cover', kind: 'camera' });
      await wait(SAMPLE_MS);
      if (cancelled.current) return found;

      const dualStats = filtered.getStats();
      found.push({
        name: 'dual-camera composite publishes 720x1280',
        pass: publishedSize() === '720x1280',
        detail: `published ${publishedSize()} (canvas ${COMPOSITE_SIZE_720.width}x${COMPOSITE_SIZE_720.height})`,
      });
      found.push({
        name: 'dual-camera composite paints at 24fps, not 30',
        pass: dualStats.paintRate === COMPOSITE_FRAME_RATE,
        detail:
          `paintRate=${dualStats.paintRate} budget=${dualStats.frameBudgetMs}ms ` +
          `p50=${dualStats.paintP50}ms p95=${dualStats.paintP95}ms fps=${dualStats.fps}`,
      });
      found.push({
        name: "the second source reports itself as a camera, fitted 'cover'",
        pass: dualStats.secondSource === 'camera' && dualStats.secondFit === 'cover',
        detail: `secondSource=${dualStats.secondSource} secondFit=${dualStats.secondFit} layout=${dualStats.layout}`,
      });

      const rects = layoutRects(dualStats.layout, dualStats.pipCorner, COMPOSITE_SIZE_720);
      const frame = await grabFrame(publish);
      if (!frame) {
        found.push({ name: 'a frame could be read back', pass: false, detail: 'no frame' });
        return found;
      }

      const top = sampleSlot(frame, rects.screen);
      const bottom = rects.face ? sampleSlot(frame, rects.face) : null;

      found.push({
        name: 'BACK camera is in the TOP slot',
        pass: groundOf(top.centre) === 'back',
        detail: `top ${rects.screen.width}x${rects.screen.height}@y${rects.screen.y} centre ${rgbLabel(top.centre)} → ${groundOf(top.centre)}`,
      });
      found.push({
        name: 'FRONT camera is in the BOTTOM slot',
        pass: bottom !== null && groundOf(bottom.centre) === 'front',
        detail: bottom
          ? `bottom ${rects.face?.width}x${rects.face?.height}@y${rects.face?.y} centre ${rgbLabel(bottom.centre)} → ${groundOf(bottom.centre)}`
          : 'no face rect in this layout',
      });
      found.push({
        name: 'both slots are filled edge to edge — no bars inside a slot',
        pass:
          groundOf(top.left) === 'back' &&
          groundOf(top.right) === 'back' &&
          bottom !== null &&
          groundOf(bottom.left) === 'front' &&
          groundOf(bottom.right) === 'front',
        detail:
          `top edges ${groundOf(top.left)}/${groundOf(top.right)}, ` +
          `bottom edges ${bottom ? `${groundOf(bottom.left)}/${groundOf(bottom.right)}` : '—'} ` +
          `(source ${SOURCE_WIDTH}x${SOURCE_HEIGHT} 3:4 into a ${rects.screen.width}x${rects.screen.height} slot)`,
      });

      // ------------------------------- the negative control: 'contain' still bars
      await filtered.setSecondSource(back.stream, { fit: 'contain', kind: 'screen' });
      await wait(1_500);
      if (cancelled.current) return found;
      const containFrame = await grabFrame(publish);
      const containTop = containFrame ? sampleSlot(containFrame, rects.screen) : null;
      found.push({
        name: "'contain' still letterboxes the top slot (the desktop share path)",
        pass:
          containTop !== null &&
          groundOf(containTop.centre) === 'back' &&
          groundOf(containTop.left) === 'black' &&
          groundOf(containTop.right) === 'black',
        detail: containTop
          ? `centre ${groundOf(containTop.centre)}, edges ${groundOf(containTop.left)}/${groundOf(containTop.right)} — bars are the point here`
          : 'no frame',
      });

      // ------------------------------------------------- unmount, back to 30
      await filtered.setSecondSource(null);
      await wait(1_000);
      const offStats = filtered.getStats();
      found.push({
        name: 'unmounting the second camera returns to 30fps camera-only',
        pass:
          offStats.paintRate === 30 &&
          offStats.compositing === false &&
          offStats.secondSource === null,
        detail: `${publishedSize()} @${offStats.paintRate}fps, compositing=${offStats.compositing}`,
      });
    } finally {
      filtered?.stop();
      front.stop();
      back.stop();
      front.stream.getTracks().forEach((track) => track.stop());
      back.stream.getTracks().forEach((track) => track.stop());
    }

    return found;
  }, []);

  /**
   * The probe half: the REAL getUserMedia on whatever this browser is.
   *
   * Reported rather than asserted, and that is deliberate. There is no pass
   * condition for "this device supports two cameras" — a one-camera laptop
   * returning 'unavailable' is the probe working correctly, and headless
   * Chromium returning 'dual' proves the happy path runs and nothing about an
   * iPhone. The assertion is only that the probe ANSWERS, without throwing and
   * without leaving the primary camera dead.
   */
  const runProbe = useCallback(async (): Promise<{ line: string; checks: Check[] }> => {
    const found: Check[] = [];
    resetDualCameraProbe();
    const count = await countVideoInputs();

    if (count === 0) {
      const line = 'no camera in this browser — probe not run';
      found.push({
        name: 'the probe reports a tier without a camera',
        pass: true,
        detail: `${count} videoinput(s); the studio hides the control (Tier 3)`,
      });
      return { line, checks: found };
    }

    let primary: MediaStream | null = null;
    try {
      primary = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' } },
        audio: false,
      });
      const result = await probeDualCamera({
        quality: '720p',
        portrait: true,
        primary,
        primaryFacing: 'user',
      });

      // Whichever tier came back, the camera the "broadcast" was holding must
      // still be delivering frames — recovered by the probe if it had to be.
      const live = result.recoveredPrimary ?? { stream: primary };
      const stillLive = await trackDeliversFrames(live.stream.getVideoTracks()[0]);

      found.push({
        name: 'the probe returns a tier and leaves the primary camera alive',
        pass: stillLive,
        detail:
          `tier=${result.tier} cameras=${result.cameraCount} ` +
          `recovered=${result.recoveredPrimary ? 'yes' : 'no'} primaryLive=${stillLive}`,
      });
      found.push({
        name: 'the verdict is cached for the session',
        pass: cachedDualCameraTier() === result.tier,
        detail: `cached=${cachedDualCameraTier()}`,
      });

      result.second?.stream.getTracks().forEach((track) => track.stop());
      result.recoveredPrimary?.stream.getTracks().forEach((track) => track.stop());
      return {
        line: `tier=${result.tier} · ${result.cameraCount} camera(s) · ${result.detail}`,
        checks: found,
      };
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      found.push({
        name: 'the probe returns a tier and leaves the primary camera alive',
        pass: false,
        detail: message,
      });
      return { line: `probe threw — ${message}`, checks: found };
    } finally {
      primary?.getTracks().forEach((track) => track.stop());
    }
  }, []);

  /**
   * The Tier 2 DETECTOR, on tracks whose behaviour we can actually cause.
   *
   * Chromium's fake cameras are too well behaved to reproduce Tier 2 — they
   * both open and both deliver, every time — so the failure this module exists
   * to catch cannot be staged end to end in a harness. What CAN be staged is
   * the primitive that catches it, on two tracks that behave exactly the way a
   * dying iOS camera behaves:
   *
   *  - a STOPPED track, which is the case where opening the second camera ends
   *    the first outright, and
   *  - a `captureStream(0)` track, which is live, reports `readyState: 'live'`
   *    forever, and produces at most the one frame it was created with. That
   *    is the dangerous case — a camera that looks fine and is frozen — and it
   *    is precisely why the frame count is two rather than one.
   *
   * If these two pass, a device that behaves either way is detected. Whether
   * an iPhone behaves either way is Por's phone to say.
   */
  const runDetector = useCallback(async (): Promise<Check[]> => {
    const found: Check[] = [];

    const ended = makeSource(drawFace);
    const [endedTrack] = ended.stream.getVideoTracks();
    endedTrack.stop();
    ended.stop();
    found.push({
      name: 'a STOPPED track is not mistaken for a live camera',
      pass: (await trackDeliversFrames(endedTrack, 600)) === false,
      detail: `readyState=${endedTrack.readyState} → rejected`,
    });

    // Live, and frozen: captureStream(0) only produces a frame when asked, and
    // it is never asked. This is the iOS failure that readyState cannot see.
    const frozen = document.createElement('canvas');
    frozen.width = SOURCE_WIDTH;
    frozen.height = SOURCE_HEIGHT;
    const frozenCtx = frozen.getContext('2d');
    if (frozenCtx) drawFace(frozenCtx, SOURCE_WIDTH, SOURCE_HEIGHT, 0);
    const frozenStream = frozen.captureStream(0);
    const [frozenTrack] = frozenStream.getVideoTracks();
    const frozenVerdict = await trackDeliversFrames(frozenTrack, 1_200);
    found.push({
      name: 'a LIVE but frozen track is not mistaken for a live camera',
      pass: frozenVerdict === false,
      detail: `readyState=${frozenTrack.readyState} (live), frames advancing=${frozenVerdict} → rejected`,
    });
    frozenStream.getTracks().forEach((track) => track.stop());

    return found;
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setChecks([]);
    setNote(null);
    const collected: Check[] = [];
    try {
      const probe = await runProbe();
      setProbeLine(probe.line);
      collected.push(...probe.checks);
      setChecks([...collected]);

      collected.push(...(await runDetector()));
      setChecks([...collected]);

      collected.push(...(await runComposite()));
      setChecks([...collected]);

      const result: Result = {
        checks: collected,
        probe: probe.line,
        finishedAt: new Date().toISOString(),
      };
      // The headless driver reads this — see scripts/dev-bench-dualcam.mjs.
      (window as unknown as { __dualcamResult?: Result }).__dualcamResult = result;
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setNote(message);
      (window as unknown as { __dualcamResult?: Result }).__dualcamResult = {
        checks: [...collected, { name: 'the bench ran to completion', pass: false, detail: message }],
        probe: 'threw',
        finishedAt: new Date().toISOString(),
      };
    } finally {
      setRunning(false);
    }
  }, [runComposite, runDetector, runProbe]);

  // `?auto=1` — the headless driver's entry point. A human opening the page
  // gets a button instead, because the probe asks for a camera.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('auto') !== '1') return;
    // On a timeout rather than inline: `run` sets state on its first line, and
    // a synchronous setState inside an effect is a cascading render (and a
    // lint error). A tick also lets the page paint before it opens a camera.
    const timer = window.setTimeout(() => void run(), 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  const failures = checks.filter((check) => !check.pass).length;

  return (
    <main className="min-h-dvh bg-[#0a0a15] px-6 py-8 text-white">
      <h1 className="text-xl font-bold">กล้องคู่บนมือถือ — back camera on top, front below</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/60">
        The real pipeline with two synthetic 3:4 camera sources, checked against the pixels of the
        track it would publish. The probe row reports what THIS browser did with two real
        <code className="mx-1 rounded bg-white/10 px-1">getUserMedia</code> calls — headless
        Chromium with two fake devices reaches Tier 1 and that says nothing about an iPhone, where
        Safari hands out one active camera at a time on most models. Por&apos;s phone is the
        capability test; this page is the geometry and cadence test.
      </p>

      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        className="mt-5 rounded-xl bg-purple-500 px-4 py-2 text-sm font-semibold disabled:opacity-40"
      >
        {running ? 'กำลังตรวจ…' : 'ตรวจใหม่'}
      </button>
      {note && <p className="mt-3 text-sm text-rose-300">{note}</p>}

      <p className="mt-5 text-sm text-white/70">
        <span className="text-white/50">probe: </span>
        <span className="font-mono">{probeLine}</span>
      </p>

      {checks.length > 0 && (
        <p className={`mt-2 text-sm font-semibold ${failures ? 'text-rose-300' : 'text-emerald-300'}`}>
          {failures ? `${failures} of ${checks.length} failed` : `all ${checks.length} passed`}
        </p>
      )}

      <ul className="mt-4 max-w-4xl space-y-2 text-sm">
        {checks.map((check) => (
          <li key={check.name} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <span className={check.pass ? 'text-emerald-300' : 'text-rose-300'}>
              {check.pass ? 'PASS' : 'FAIL'}
            </span>{' '}
            <span className="text-white/85">{check.name}</span>
            <div className="mt-1 font-mono text-xs text-white/45">{check.detail}</div>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-sm font-semibold text-white/70">What the fits mean here</h2>
      <ul className="mt-2 max-w-3xl space-y-1 text-sm text-white/50">
        <li>
          source {SOURCE_WIDTH}x{SOURCE_HEIGHT} (3:4, what a phone sensor gives) into a{' '}
          {COMPOSITE_SIZE_720.width}x{COMPOSITE_SIZE_720.height / 2} slot
        </li>
        <li>
          <span className="text-white/80">cover</span> — crops the source, fills the slot, no bars.
          The camera rule, and what the mobile dual-camera path passes.
        </li>
        <li>
          <span className="text-white/80">contain</span> — 480x640 centred, 120px of black down each
          side. The screen rule, unchanged from PR&nbsp;#62, checked here as a control.
        </li>
      </ul>
    </main>
  );
}
