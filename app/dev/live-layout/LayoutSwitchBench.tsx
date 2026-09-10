'use client';

/**
 * The layout-switch freeze, measured rather than argued. See ./page.tsx.
 *
 * Five sections, in the order the numbers are cheapest to get:
 *
 *   L4 (geometry)   pure arithmetic, no browser state at all
 *   L5 (preview)    one div, measured by the layout engine
 *   L1 (resize)     the shipping pipeline, source shrunk mid-composite
 *   L2 (throw)      the shipping pipeline, drawImage sabotaged, both painters
 *   L3 (reconfigure) the shipping startScreenShare, display picker stubbed
 *
 * EVERY ASSERTION IS ABOUT THE LOOP STILL RUNNING, not about it looking right.
 * `paintedFrames` is a counter the pipeline advances once per completed paint
 * and never resets; a broadcast that has frozen is one where it stops moving.
 * `fps` cannot answer this — it is a one-second average that keeps its last
 * value forever once nothing updates it, so a frozen composite reports a
 * healthy 24 for the rest of the broadcast. That property is exactly why the
 * bug was invisible in the logs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createFilteredStream, type FilteredStream } from '@/lib/live/cameraFilters';
import {
  COMPOSITE_LAYOUT_LABELS,
  COMPOSITE_LAYOUT_ORDER,
  COMPOSITE_SIZE_1080,
  chartPanAnchor,
  clampSourceRect,
  containRect,
  coverSourceRect,
  layoutRects,
  screenSlotFit,
  type ChartPan,
  type CompositeLayout,
  type ScreenFit,
} from '@/lib/live/compositeCanvas';
import { startScreenShare, type ScreenShareSession } from '@/lib/live/screenShareCapture';
import { SHARE_PICKER_HINT } from '@/lib/live/screenShareCopy';
import { previewBoxClass } from '@/components/live/previewBox';
import { resolutionFor } from '@/lib/live/livekitClient';

/** One assertion, and the numbers behind it. */
interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** The monitor a creator shares from, and what a cap moves it to. */
const MONITOR = { width: 2560, height: 1440 };
const CAPPED = { width: 1920, height: 1080 };
/** The webcam, as a desktop opens it. */
const CAMERA = { width: 1280, height: 720 };

/** Long enough for a stall to be a stall rather than a scheduling hiccup. */
const OBSERVE_MS = 1_200;
/** How long `drawImage` is sabotaged for. Two log windows would be 10s. */
const SABOTAGE_MS = 1_000;
/** Twenty switches, which is more than a creator does while finding a preset. */
const SWITCH_COUNT = 20;
/** Between switches — fast enough to be a creator jabbing, slow enough to paint. */
const SWITCH_GAP_MS = 250;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/* ------------------------------------------------------------------ sources */

function drawChart(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);
  const candles = 60;
  const cw = w / candles;
  for (let i = 0; i < candles; i += 1) {
    const seed = Math.sin((i + t) * 0.7);
    const mid = h / 2 + seed * h * 0.28;
    const body = Math.abs(Math.sin((i + t) * 1.3)) * h * 0.06 + 4;
    ctx.fillStyle = seed > 0 ? '#26a69a' : '#ef5350';
    ctx.fillRect(i * cw + 1, mid - body / 2, Math.max(1, cw - 2), body);
  }
  // The price axis, hard against the right edge — the column a right-anchored
  // `cover` must keep and a left-anchored one must lose.
  ctx.fillStyle = '#c9a227';
  ctx.fillRect(w - Math.round(w * 0.03), 0, Math.round(w * 0.03), h);
}

function drawFace(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.fillStyle = '#1b2330';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#7c4dff';
  ctx.beginPath();
  ctx.ellipse(w / 2 + Math.sin(t) * w * 0.03, h / 2, w * 0.14, h * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * A canvas repainted on an interval and captured as a track. A fake device.
 *
 * `resize` is the whole reason this is not the chart bench's `makeSource`:
 * writing to `canvas.width` mid-capture changes the TRACK's frame size, which
 * is what a display capture does when a window is resized or when
 * `applyConstraints` reconfigures it — and it is the event the composite has
 * to survive without being told about it.
 */
function makeSource(
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void,
): {
  stream: MediaStream;
  canvas: HTMLCanvasElement;
  resize: (w: number, h: number) => void;
  stop: () => void;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  let t = 0;
  const tick = () => {
    t += 0.15;
    paint(ctx, canvas.width, canvas.height, t);
  };
  tick();
  const timer = window.setInterval(tick, 1000 / 30);
  return {
    stream: canvas.captureStream(30),
    canvas,
    resize: (w, h) => {
      canvas.width = w;
      canvas.height = h;
      tick();
    },
    stop: () => window.clearInterval(timer),
  };
}

/* ------------------------------------------------------- reading the frame */

/** The published canvas, as pixels, for "is the picture actually moving?". */
async function grabFrame(stream: MediaStream): Promise<ImageData | null> {
  const [track] = stream.getVideoTracks();
  if (!track) return null;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await video.play().catch(() => undefined);
  await wait(250);
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

/** How different two published frames are, as a share of sampled pixels. */
function frameDelta(a: ImageData, b: ImageData): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  let sampled = 0;
  // Every 97th pixel: a prime stride so a repeating pattern in the source
  // cannot align with it, and cheap enough to run on a 1080x1920 frame.
  for (let i = 0; i < a.data.length; i += 4 * 97) {
    sampled += 1;
    if (Math.abs(a.data[i] - b.data[i]) > 6) changed += 1;
  }
  return sampled === 0 ? 0 : changed / sampled;
}

/* --------------------------------------------------- sabotage and the spy */

/**
 * Make every `drawImage` throw, for a while. The forced bad frame.
 *
 * `IndexSizeError` is the name Chrome gives the real one — a source rectangle
 * that no longer fits the decoded frame — so it is the name used here, and the
 * assertion is not about which error it is: it is that ANY error out of the
 * paint callback is survivable. Restoring the prototype is in a returned
 * function rather than a timer so a failed check cannot leave the page's
 * canvas API broken for the sections after it.
 */
function sabotageDrawImage(): () => void {
  const proto = CanvasRenderingContext2D.prototype as unknown as Record<string, unknown>;
  const original = proto.drawImage;
  proto.drawImage = function sabotaged() {
    throw new DOMException('bench: forced source-rect failure', 'IndexSizeError');
  };
  return () => {
    proto.drawImage = original;
  };
}

/**
 * A display capture that is not one: a canvas track wearing a screen's clothes.
 *
 * `startScreenShare` is the shipping function and is called unmodified — what
 * is replaced is the browser's picker underneath it, which is the one part
 * that cannot exist in CI. The track reports a `displaySurface`, reports its
 * own size through `getSettings`, and COUNTS `applyConstraints`, which is the
 * measurement L3 is entirely about.
 */
function stubDisplayMedia(source: ReturnType<typeof makeSource>, displaySurface: string) {
  const media = navigator.mediaDevices as unknown as Record<string, unknown>;
  const original = media.getDisplayMedia;
  const constraintCalls: MediaTrackConstraints[] = [];

  const [track] = source.stream.getVideoTracks();
  const patched = track as unknown as Record<string, unknown>;
  patched.getSettings = () => ({
    width: source.canvas.width,
    height: source.canvas.height,
    frameRate: 30,
    displaySurface,
  });
  patched.applyConstraints = async (constraints: MediaTrackConstraints) => {
    constraintCalls.push(constraints);
    const video = constraints as { width?: { max?: number }; height?: { max?: number } };
    const maxWidth = video.width?.max;
    const maxHeight = video.height?.max;
    if (maxWidth && maxHeight && source.canvas.width > maxWidth) {
      // A real reconfigure changes the frame size, which is what makes the
      // composite's <video> fire `resize` — the event holdSecondSlot waits on.
      const scale = Math.min(maxWidth / source.canvas.width, maxHeight / source.canvas.height);
      source.resize(
        Math.round((source.canvas.width * scale) / 2) * 2,
        Math.round((source.canvas.height * scale) / 2) * 2,
      );
    }
  };

  media.getDisplayMedia = async () => source.stream;
  return {
    constraintCalls,
    restore: () => {
      media.getDisplayMedia = original;
    },
  };
}

/* ------------------------------------------------------------------ tables */

interface FrameRow {
  when: string;
  painted: number;
  paintErrors: number;
  fps: number;
  /** Share of sampled pixels that changed between two grabs. 0 is a still. */
  pictureDelta: string;
  verdict: string;
}

interface RectRow {
  layout: CompositeLayout;
  fit: ScreenFit;
  slot: string;
  drawnAs: string;
  sourceRead: string;
  /** Published pixels the chart actually occupies. Black bars excluded. */
  chartPixels: number;
  /** Where the crop window's left edge sits in the source, per pan. */
  panLeftEdges: string;
  even: boolean;
}

interface Result {
  checks: Check[];
  frames: FrameRow[];
  rects: RectRow[];
  reconfigures: string;
  finishedAt: string;
}

declare global {
  interface Window {
    __layoutResult?: Result;
  }
}

/* -------------------------------------------------------------------- page */

export function LayoutSwitchBench() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [frames, setFrames] = useState<FrameRow[]>([]);
  const [rects, setRects] = useState<RectRow[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const run = useCallback(async () => {
    setRunning(true);
    setChecks([]);
    setFrames([]);
    setRects([]);
    setNote(null);

    const found: Check[] = [];
    const frameRows: FrameRow[] = [];
    const rectRows: RectRow[] = [];
    let reconfigures = '—';

    /* ================================================== L4: the geometry */
    // Pure, so it runs first and costs nothing. The 1080p rung, on a 2560x1440
    // monitor, which is the case Por screenshotted.
    const size = COMPOSITE_SIZE_1080;
    for (const layout of COMPOSITE_LAYOUT_ORDER) {
      for (const fit of ['fill', 'whole'] as ScreenFit[]) {
        const slot = layoutRects(layout, 'bottom-right', size).screen;
        const drawn = screenSlotFit('screen', fit);
        if (drawn === 'cover') {
          const src = coverSourceRect(
            MONITOR.width,
            MONITOR.height,
            slot,
            1,
            chartPanAnchor('right'),
          );
          rectRows.push({
            layout,
            fit,
            slot: `${slot.width}x${slot.height}`,
            drawnAs: drawn,
            sourceRead: `${Math.round(src.width)}x${Math.round(src.height)}`,
            chartPixels: slot.width * slot.height,
            panLeftEdges: (['left', 'center', 'right'] as ChartPan[])
              .map(
                (pan) =>
                  `${pan}=${Math.round(
                    coverSourceRect(MONITOR.width, MONITOR.height, slot, 1, chartPanAnchor(pan)).x,
                  )}`,
              )
              .join(' '),
            even: slot.width % 2 === 0 && slot.height % 2 === 0,
          });
        } else {
          const box = containRect(MONITOR.width, MONITOR.height, slot);
          rectRows.push({
            layout,
            fit,
            slot: `${slot.width}x${slot.height}`,
            drawnAs: drawn,
            sourceRead: `${MONITOR.width}x${MONITOR.height}`,
            chartPixels: box.width * box.height,
            panLeftEdges: '—',
            even: box.width % 2 === 0 && box.height % 2 === 0,
          });
        }
      }
    }
    setRects([...rectRows]);

    const fillRows = rectRows.filter((row) => row.fit === 'fill');
    const wholeRows = rectRows.filter((row) => row.fit === 'whole');
    found.push({
      name: 'at เต็มช่อง every screen layout fills its slot edge to edge',
      pass: fillRows.length === 4 && fillRows.every((row) => row.drawnAs === 'cover'),
      detail: fillRows.map((row) => `${row.layout}=${row.drawnAs} ${row.slot}`).join(', '),
    });
    const screenFill = fillRows.find((row) => row.layout === 'screen');
    const screenWhole = wholeRows.find((row) => row.layout === 'screen');
    found.push({
      name: 'เฉพาะหน้าจอ gains the whole frame back — the contained strip is gone',
      pass:
        !!screenFill &&
        !!screenWhole &&
        screenFill.chartPixels === size.width * size.height &&
        screenFill.chartPixels > screenWhole.chartPixels * 3,
      detail: screenWhole
        ? `whole (old default): ${screenWhole.chartPixels.toLocaleString()}px, ` +
          `fill (new default): ${screenFill?.chartPixels.toLocaleString()}px — ` +
          `${((screenFill!.chartPixels / screenWhole.chartPixels) * 100 - 100).toFixed(0)}% more`
        : 'no row',
    });
    found.push({
      name: 'every slot is even in both dimensions, at every fit',
      pass: rectRows.every((row) => row.even),
      detail: rectRows
        .filter((row) => !row.even)
        .map((row) => `${row.layout}/${row.fit} ${row.slot}`)
        .join(', ') || 'all even',
    });
    const panRow = fillRows.find((row) => row.layout === 'screen');
    const panLeft = coverSourceRect(
      MONITOR.width,
      MONITOR.height,
      layoutRects('screen', 'bottom-right', size).screen,
      1,
      chartPanAnchor('left'),
    );
    const panRight = coverSourceRect(
      MONITOR.width,
      MONITOR.height,
      layoutRects('screen', 'bottom-right', size).screen,
      1,
      chartPanAnchor('right'),
    );
    found.push({
      name: 'the pan moves the crop window, and ขวา keeps the right edge',
      pass:
        panRight.x > panLeft.x &&
        panLeft.x === 0 &&
        Math.round(panRight.x + panRight.width) === MONITOR.width,
      detail: panRow
        ? `left x=${Math.round(panLeft.x)}, right x=${Math.round(panRight.x)} ` +
          `(+${Math.round(panRight.width)} = ${Math.round(panRight.x + panRight.width)} of ${MONITOR.width})`
        : 'no row',
    });
    found.push({
      name: 'a source rect that runs off the source is clamped, never negative',
      pass: (() => {
        const clamped = clampSourceRect(
          { x: 1800, y: -40, width: 900, height: 1600 },
          1920,
          1080,
        );
        const empty = clampSourceRect({ x: 4000, y: 0, width: 100, height: 100 }, 1920, 1080);
        const nan = clampSourceRect({ x: NaN, y: 0, width: 10, height: 10 }, 1920, 1080);
        return (
          clamped.x === 1800 &&
          clamped.y === 0 &&
          clamped.width === 120 &&
          clamped.height === 1080 &&
          empty.width === 0 &&
          nan.width === 0
        );
      })(),
      detail: JSON.stringify(clampSourceRect({ x: 1800, y: -40, width: 900, height: 1600 }, 1920, 1080)),
    });
    found.push({
      name: 'a back camera is cover at both settings — the toggle is the screen’s alone',
      pass: screenSlotFit('camera', 'whole') === 'cover' && screenSlotFit('camera', 'fill') === 'cover',
      detail: `camera/whole=${screenSlotFit('camera', 'whole')}, camera/fill=${screenSlotFit('camera', 'fill')}`,
    });
    setChecks([...found]);

    /* =============================================== L5: the preview box */
    const probe = probeRef.current;
    if (probe) {
      const measure = (compositing: boolean) => {
        const box = document.createElement('div');
        box.className = previewBoxClass(compositing);
        probe.appendChild(box);
        const rect = box.getBoundingClientRect();
        probe.removeChild(box);
        return rect;
      };
      const composite = measure(true);
      const cameraOnly = measure(false);
      const ratio = composite.height > 0 ? composite.width / composite.height : 0;
      found.push({
        name: 'the preview box is 9:16 while compositing and full-width camera-only',
        pass:
          Math.abs(ratio - 9 / 16) < 0.02 &&
          cameraOnly.width > composite.width * 1.5 &&
          composite.height > 0,
        detail:
          `compositing ${Math.round(composite.width)}x${Math.round(composite.height)} ` +
          `(${ratio.toFixed(3)}, want ${(9 / 16).toFixed(3)}); camera-only ` +
          `${Math.round(cameraOnly.width)}x${Math.round(cameraOnly.height)}`,
      });
      setChecks([...found]);
    }

    /* ============================================= the composite itself */
    const camera = makeSource(CAMERA.width, CAMERA.height, drawFace);
    let filtered: FilteredStream | null = null;
    let screen: ReturnType<typeof makeSource> | null = null;

    try {
      /* ------------------------------- L1: the source resizes mid-stream */
      screen = makeSource(MONITOR.width, MONITOR.height, drawChart);
      filtered = await createFilteredStream(
        camera.stream,
        'none',
        resolutionFor('1080p').frameRate,
        false,
        undefined,
        true,
        size,
      );
      await filtered.setSecondSource(screen.stream, { kind: 'screen' });
      filtered.setCompositeLayout('chartfull');
      // The first paints include a canvas resize and the screen's first
      // decodes; a counter read across them says nothing about steady state.
      await wait(1_200);

      const observe = async (when: string): Promise<FrameRow> => {
        const before = filtered!.getStats();
        const firstFrame = await grabFrame(filtered!.publishStream);
        await wait(OBSERVE_MS);
        const after = filtered!.getStats();
        const secondFrame = await grabFrame(filtered!.publishStream);
        const painted = after.paintedFrames - before.paintedFrames;
        const delta =
          firstFrame && secondFrame ? frameDelta(firstFrame, secondFrame) : -1;
        return {
          when,
          painted,
          paintErrors: after.paintErrors,
          fps: after.fps,
          pictureDelta: delta < 0 ? 'n/a' : `${(delta * 100).toFixed(1)}%`,
          verdict: painted > 0 ? 'running' : 'FROZEN',
        };
      };

      frameRows.push(await observe('steady, 2560x1440 source'));
      setFrames([...frameRows]);
      if (cancelled.current) return;

      // THE RESIZE. Exactly what `capTo1080` produces, without the capture
      // stack: the decoded frame is 1920x1080 from the next frame on, and
      // every rect the composite computed a moment ago described a 2560x1440
      // one. Nothing tells the pipeline it happened.
      screen.resize(CAPPED.width, CAPPED.height);
      frameRows.push(await observe('after the source shrank to 1920x1080'));
      setFrames([...frameRows]);
      if (cancelled.current) return;

      // And back up, which a creator does by un-maximising a shared window.
      screen.resize(MONITOR.width, MONITOR.height);
      frameRows.push(await observe('after the source grew back to 2560x1440'));
      setFrames([...frameRows]);

      const resizeRows = frameRows.slice(0, 3);
      found.push({
        name: 'a source that changes size mid-stream does not stop the loop',
        pass: resizeRows.every((row) => row.painted > 0),
        detail: resizeRows.map((row) => `${row.when}: ${row.painted} frames`).join(' | '),
      });
      found.push({
        name: 'and the published picture keeps moving across the resize',
        pass: resizeRows.every((row) => row.pictureDelta === 'n/a' || parseFloat(row.pictureDelta) > 0),
        detail: resizeRows.map((row) => `${row.when}: ${row.pictureDelta} of pixels changed`).join(' | '),
      });
      setChecks([...found]);
      if (cancelled.current) return;

      /* ------------------------- L2: an exception in the paint callback */
      const errorsBefore = filtered.getStats().paintErrors;
      const restore = sabotageDrawImage();
      await wait(SABOTAGE_MS);
      restore();
      const duringErrors = filtered.getStats().paintErrors - errorsBefore;
      frameRows.push(await observe('after drawImage threw for 1s'));
      setFrames([...frameRows]);

      found.push({
        name: 'a throwing drawImage is caught, counted, and the loop keeps painting',
        pass: duringErrors > 0 && frameRows[frameRows.length - 1].painted > 0,
        detail:
          `${duringErrors} paint errors caught during the sabotage, ` +
          `${frameRows[frameRows.length - 1].painted} frames painted after it`,
      });
      setChecks([...found]);
      if (cancelled.current) return;

      /*
        THE SAME SABOTAGE WITH THE FRAME-CALLBACK CHAIN AS THE PAINTER.

        This is the case that used to be UNRECOVERABLE and it is worth its own
        section. While compositing, the worker ticker normally holds the clock
        and an uncaught throw in its message handler costs one frame — bad, not
        fatal. Where a Worker cannot be built (a Content-Security-Policy with
        no `worker-src blob:`) rVFC is the painter, and rVFC re-arms itself
        from inside its own callback: one throw and the chain is never
        scheduled again, for the rest of the broadcast.

        `window.Worker` is removed before the pipeline is built, which is the
        supported way to reach that path from here — `startTicker` checks for
        it exactly once, on construction.
      */
      filtered.stop();
      screen.stop();
      screen = makeSource(MONITOR.width, MONITOR.height, drawChart);

      const globals = window as unknown as Record<string, unknown>;
      const RealWorker = globals.Worker;
      delete globals.Worker;
      try {
        filtered = await createFilteredStream(
          camera.stream,
          'none',
          resolutionFor('1080p').frameRate,
          false,
          undefined,
          true,
          size,
        );
      } finally {
        globals.Worker = RealWorker;
      }
      await filtered.setSecondSource(screen.stream, { kind: 'screen' });
      filtered.setCompositeLayout('split');
      await wait(1_200);

      const noWorkerBefore = filtered.getStats().paintedFrames;
      const restoreAgain = sabotageDrawImage();
      await wait(SABOTAGE_MS);
      restoreAgain();
      const noWorkerRow = await observe('rVFC painter, after drawImage threw for 1s');
      frameRows.push(noWorkerRow);
      setFrames([...frameRows]);

      found.push({
        name: 'with no worker, the frame-callback chain re-arms itself through the throw',
        pass: noWorkerRow.painted > 0,
        detail:
          `${filtered.getStats().paintedFrames - noWorkerBefore} frames painted since the ` +
          `sabotage began; ${noWorkerRow.painted} in the ${OBSERVE_MS}ms after it — ` +
          `${noWorkerRow.verdict}`,
      });
      setChecks([...found]);
      if (cancelled.current) return;

      /* ------------------- L3: how often does a share touch its track? */
      filtered.stop();
      screen.stop();
      screen = makeSource(MONITOR.width, MONITOR.height, drawChart);
      filtered = await createFilteredStream(
        camera.stream,
        'none',
        resolutionFor('1080p').frameRate,
        false,
        undefined,
        true,
        size,
      );

      const stub = stubDisplayMedia(screen, 'browser');
      let session: ScreenShareSession | null = null;
      try {
        session = await startScreenShare(() => undefined, '1080p', {
          measurePaint: () => {
            const stats = filtered!.getStats();
            if (!stats.compositing || !(stats.frameBudgetMs > 0)) return null;
            return { p95: stats.paintP95, budgetMs: stats.frameBudgetMs };
          },
          onReconfigure: () => filtered!.holdSecondSlot(),
        });
        if (!session) throw new Error('the stubbed picker returned nothing');
        await filtered.setSecondSource(session.stream, { kind: 'screen' });

        found.push({
          name: 'the share reports which surface the creator picked',
          pass: session.surface === 'tab',
          detail: `displaySurface 'browser' -> surface '${session.surface}'`,
        });

        /*
          TWENTY SWITCHES, ACROSS AND PAST EVERY WINDOW THAT USED TO MATTER.

          The old wiring re-armed a six-second timer on every layout change and
          called `applyConstraints` when it fired, so twenty switches at 250ms
          spans the two-second decision window this replaces it with AND runs
          well past the six-second mark the old timer would have fired at. The
          fit toggle is flipped along the way because it changes the paint cost
          the same way a layout used to — if anything could still reopen the
          decision, this is where it would show.
        */
        const beforeSwitching = filtered.getStats();
        for (let i = 0; i < SWITCH_COUNT; i += 1) {
          filtered.setCompositeLayout(COMPOSITE_LAYOUT_ORDER[i % COMPOSITE_LAYOUT_ORDER.length]);
          if (i % 5 === 4) filtered.setScreenFit(i % 10 === 4 ? 'whole' : 'fill');
          await wait(SWITCH_GAP_MS);
        }
        filtered.setScreenFit('fill');
        const afterSwitching = filtered.getStats();
        const switchRow = await observe(`after ${SWITCH_COUNT} layout switches`);
        frameRows.push(switchRow);
        setFrames([...frameRows]);

        reconfigures =
          `${stub.constraintCalls.length} applyConstraints call(s), ` +
          `session.reconfigureCount()=${session.reconfigureCount()}`;

        found.push({
          name: `${SWITCH_COUNT} layout switches reconfigure the capture track at most once`,
          pass: stub.constraintCalls.length <= 1 && session.reconfigureCount() <= 1,
          detail: reconfigures,
        });
        found.push({
          name: 'and the composite never stops painting while they happen',
          pass:
            afterSwitching.paintedFrames > beforeSwitching.paintedFrames &&
            switchRow.painted > 0,
          detail:
            `${afterSwitching.paintedFrames - beforeSwitching.paintedFrames} frames across the ` +
            `switches, ${switchRow.painted} in the ${OBSERVE_MS}ms after — ${switchRow.verdict}, ` +
            `${afterSwitching.paintErrors} paint errors`,
        });

        // The decision closes on its own, whatever it decided, and nothing can
        // reopen it. Awaited rather than assumed: an unresolved promise here
        // would mean a window that never shut.
        const decided = await Promise.race([
          session.sizeDecided,
          wait(4_000).then(() => 'timeout' as const),
        ]);
        found.push({
          name: 'the capture-size decision closes inside the share’s first seconds',
          pass: decided !== 'timeout',
          detail:
            decided === 'timeout'
              ? 'still undecided after 4s'
              : `decided: ${decided ? `${decided.width}x${decided.height}` : 'nothing asked'} ` +
                `(hardwareConcurrency=${navigator.hardwareConcurrency})`,
        });
        found.push({
          name: 'the tab-share hint names the tab',
          pass: SHARE_PICKER_HINT.includes('แท็บ'),
          detail: SHARE_PICKER_HINT,
        });
        setChecks([...found]);
      } finally {
        session?.stop();
        stub.restore();
      }
    } catch (err) {
      setNote(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      found.push({
        name: 'the bench ran to completion',
        pass: false,
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    } finally {
      filtered?.stop();
      screen?.stop();
      camera.stop();
    }

    setChecks([...found]);
    setRunning(false);
    window.__layoutResult = {
      checks: found,
      frames: frameRows,
      rects: rectRows,
      reconfigures,
      finishedAt: new Date().toISOString(),
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('auto') !== '1') return;
    // On a timeout rather than inline: `run` sets state on its first line, and
    // a synchronous setState inside an effect is a cascading render (and a
    // lint error). Same shape as /dev/live-chart.
    const timer = window.setTimeout(() => void run(), 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  return (
    <main className="min-h-dvh bg-[#070a12] p-6 text-sm text-white/85">
      <h1 className="text-lg font-semibold">/dev/live-layout — layout switch, black and freeze</h1>
      <p className="mt-1 max-w-3xl text-white/55">
        L1 a source that resizes mid-stream · L2 an exception in the paint callback, under both
        painters · L3 how often a share reconfigures its capture track across {SWITCH_COUNT}{' '}
        layout switches · L4 the chart&apos;s rect in every layout at both fits · L5 the shape of
        the creator&apos;s preview.
      </p>

      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        className="mt-4 rounded-lg bg-cyan-400/20 px-3 py-2 font-medium text-cyan-100 disabled:opacity-50"
      >
        {running ? 'กำลังวัด...' : 'Run'}
      </button>
      {note && <p className="mt-2 text-rose-300">{note}</p>}

      {/* The L5 probe: a real flex column, the height of a studio preview
          area, that the studio's own class string is measured inside. Off
          screen rather than display:none — a hidden box has no layout. */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-[-9999px] top-0 flex h-[560px] w-[1330px] min-h-0 flex-col gap-3"
        ref={probeRef}
      />

      <Section title="checks">
        <ul className="space-y-1">
          {checks.map((check) => (
            <li key={check.name}>
              <span className={check.pass ? 'text-emerald-300' : 'text-rose-300'}>
                {check.pass ? 'PASS' : 'FAIL'}
              </span>{' '}
              {check.name}
              <div className="pl-12 text-white/45">{check.detail}</div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="the loop, across each event">
        <Table
          rows={frames as unknown as Record<string, unknown>[]}
          columns={['when', 'painted', 'paintErrors', 'fps', 'pictureDelta', 'verdict']}
        />
      </Section>

      <Section title="the chart's rect at 1080p, on a 2560x1440 monitor">
        <Table
          rows={rects as unknown as Record<string, unknown>[]}
          columns={['layout', 'fit', 'drawnAs', 'slot', 'sourceRead', 'chartPixels', 'panLeftEdges']}
        />
        <p className="mt-2 text-white/45">
          {COMPOSITE_LAYOUT_ORDER.map((layout) => COMPOSITE_LAYOUT_LABELS[layout]).join(' · ')}
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 font-semibold text-white/70">{title}</h2>
      {children}
    </section>
  );
}

function Table({ rows, columns }: { rows: Record<string, unknown>[]; columns: string[] }) {
  if (rows.length === 0) return <p className="text-white/40">(none)</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-xs tabular-nums">
        <thead className="text-white/45">
          <tr>
            {columns.map((column) => (
              <th key={column} className="pr-4 font-normal">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} className="pr-4">
                  {String(row[column] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
