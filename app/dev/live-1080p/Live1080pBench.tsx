'use client';

/**
 * The 1080p rung's paint cost, measured on the real pipeline.
 *
 * THE SOURCES ARE SYNTHETIC AND THAT IS THE POINT. A webcam is not available
 * in CI, gives a different frame on every machine, and — crucially — a face is
 * the CHEAP half of this measurement. What decides whether 1080p is publishable
 * is a candlestick chart: thin lines, small axis labels, detail corner to
 * corner, which is both the worst case for a downscaling `drawImage` and the
 * content the rung exists for. Drawing one here means the number below is
 * comparable across runs and across machines.
 *
 * WHAT IT MEASURES is `getStats().paintP95` — the span of one paint across
 * EVERY target in a tick, preview and publish both, which is what the loop
 * owes the next frame — against `frameBudgetMs`, which is 41.7ms while
 * compositing at 24fps and 33.3ms camera-only at 30. Under budget is headroom;
 * at budget is a broadcast about to fall over, which is what PR #64 found.
 *
 * WHAT IT DOES NOT MEASURE is the encoder. A paint that fits says the frame
 * reaches the encoder on time; it says nothing about whether the encoder can
 * finish it. That half is handled where it has to be — `maxFramerate`,
 * `degradationPreference` and the bitrate ceiling on the sender — and is only
 * observable on a real broadcast.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createFilteredStream, type FilteredStream } from '@/lib/live/cameraFilters';
import {
  COMPOSITE_LAYOUT_ORDER,
  compositeSizeFor,
  screenCaptureCapFor,
  type CompositeLayout,
} from '@/lib/live/compositeCanvas';
import { QUALITY_OPTIONS, publishBitrateFor } from '@/lib/live/constants';
import { resolutionFor } from '@/lib/live/livekitClient';
import type { BroadcastQuality } from '@/lib/live/types';

/** The rungs worth measuring: the default, and the one being added. */
const RUNGS: BroadcastQuality[] = ['720p', '1080p'];

/** Long enough for the percentiles to settle, short enough to sit through. */
const SAMPLE_MS = 6_000;

interface Row {
  quality: BroadcastQuality;
  mode: 'camera-only' | CompositeLayout;
  /** What the published canvas track actually reports. The claim being tested. */
  published: string;
  paintP50: number;
  paintP95: number;
  frameBudgetMs: number;
  paintRate: number;
  fps: number;
}

/**
 * A candlestick chart, drawn frame by frame. The share source.
 *
 * Deliberately busy: a grid, ninety candles, a price axis and a time axis, all
 * redrawn every tick so no frame can be a cached blit. This is what a creator
 * shares, and it is the frame that made the 720p composite stutter before
 * PR #64 capped the capture.
 */
function drawChart(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#232a35';
  ctx.lineWidth = 1;
  for (let y = 0; y < h; y += Math.round(h / 24)) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
  for (let x = 0; x < w; x += Math.round(w / 32)) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }

  const candles = 90;
  const cw = w / candles;
  for (let i = 0; i < candles; i += 1) {
    const seed = Math.sin((i + t) * 0.7) * 0.5 + Math.sin((i + t) * 0.23) * 0.5;
    const mid = h / 2 + seed * h * 0.28;
    const body = Math.abs(Math.sin((i + t) * 1.3)) * h * 0.05 + 4;
    ctx.strokeStyle = seed > 0 ? '#26a69a' : '#ef5350';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(i * cw + cw / 2, mid - body);
    ctx.lineTo(i * cw + cw / 2, mid + body);
    ctx.stroke();
    ctx.fillRect(i * cw + 1, mid - body / 2, Math.max(1, cw - 2), body);
  }

  // The axis labels — the detail that is unreadable at 720p on a phone, which
  // is the entire reason this rung exists.
  ctx.fillStyle = '#8b949e';
  ctx.font = `${Math.round(h / 60)}px monospace`;
  for (let i = 0; i < 24; i += 1) {
    ctx.fillText((1.08 + i * 0.0012).toFixed(5), w - Math.round(w / 9), (i + 1) * (h / 25));
  }
  for (let i = 0; i < 12; i += 1) {
    ctx.fillText(`${String(i * 2).padStart(2, '0')}:00`, i * (w / 12) + 4, h - 4);
  }
}

/** A face: a subject in the middle, no fine detail. What a webcam costs. */
function drawFace(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.fillStyle = '#1b2330';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#c9a227';
  ctx.beginPath();
  ctx.ellipse(w / 2 + Math.sin(t) * w * 0.03, h / 2, w * 0.14, h * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** A canvas repainted on an interval, captured as a track. A fake device. */
function makeSource(
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void,
): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  let t = 0;
  paint(ctx, width, height, t);
  // 30, the rate a camera and a capped display capture both run at.
  const timer = window.setInterval(() => {
    t += 0.15;
    paint(ctx, width, height, t);
  }, 1000 / 30);
  return { stream: canvas.captureStream(30), stop: () => window.clearInterval(timer) };
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function Live1080pBench() {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => { cancelled.current = true; }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setRows([]);
    setNote(null);
    const collected: Row[] = [];

    try {
      for (const quality of RUNGS) {
        const size = compositeSizeFor(quality);
        const cap = screenCaptureCapFor(quality);
        const cam = resolutionFor(quality);
        // The camera as a desktop opens it: the rung's own resolution, 16:9.
        const camera = makeSource(Math.max(cam.width, cam.height), Math.min(cam.width, cam.height), drawFace);
        const screen = makeSource(cap.width, cap.height, drawChart);

        let filtered: FilteredStream | null = null;
        try {
          // Exactly the call CreatorBroadcaster makes on a desktop broadcast:
          // no long-edge cap, portrait publish frame on, and the rung's size.
          filtered = await createFilteredStream(
            camera.stream,
            'none',
            cam.frameRate,
            false,
            undefined,
            true,
            size,
          );

          const [publishTrack] = filtered.publishStream.getVideoTracks();
          const publishedSize = () => {
            const s = publishTrack?.getSettings() ?? {};
            return `${s.width ?? '?'}x${s.height ?? '?'}`;
          };

          // Camera-only first — the path every broadcast starts on.
          await wait(SAMPLE_MS);
          if (cancelled.current) return;
          let stats = filtered.getStats();
          collected.push({
            quality,
            mode: 'camera-only',
            published: publishedSize(),
            paintP50: stats.paintP50,
            paintP95: stats.paintP95,
            frameBudgetMs: stats.frameBudgetMs,
            paintRate: stats.paintRate,
            fps: stats.fps,
          });
          setRows([...collected]);

          // Then each arrangement, with the share mounted.
          await filtered.setSecondSource(screen.stream, { fit: 'contain', kind: 'screen' });
          for (const layout of COMPOSITE_LAYOUT_ORDER) {
            filtered.setCompositeLayout(layout);
            await wait(SAMPLE_MS);
            if (cancelled.current) return;
            stats = filtered.getStats();
            collected.push({
              quality,
              mode: layout,
              published: publishedSize(),
              paintP50: stats.paintP50,
              paintP95: stats.paintP95,
              frameBudgetMs: stats.frameBudgetMs,
              paintRate: stats.paintRate,
              fps: stats.fps,
            });
            setRows([...collected]);
          }
          await filtered.setSecondSource(null);
        } finally {
          filtered?.stop();
          camera.stop();
          screen.stop();
          camera.stream.getTracks().forEach((track) => track.stop());
          screen.stream.getTracks().forEach((track) => track.stop());
        }
      }
    } catch (err) {
      setNote(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <main className="min-h-dvh bg-[#0a0a15] px-6 py-8 text-white">
      <h1 className="text-xl font-bold">1080p publish — paint cost against the frame budget</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/60">
        The real pipeline, at both rungs, with a synthetic chart as the share and a synthetic face as
        the camera. p95 is the span of one paint across every target in a tick — the preview and the
        published canvas both. Over 100% of budget is a frame painted late, which is the stutter
        PR&nbsp;#64 fixed. A browser rasterizing in software (headless, or a machine with no GPU
        compositing) reads several times slower than a creator&apos;s laptop, so treat the RATIO
        between the two rungs as the finding and the absolute number as an upper bound.
      </p>

      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        className="mt-5 rounded-xl bg-purple-500 px-4 py-2 text-sm font-semibold disabled:opacity-40"
      >
        {running ? 'กำลังวัด…' : 'วัดใหม่'}
      </button>
      {note && <p className="mt-3 text-sm text-rose-300">{note}</p>}

      <table className="mt-6 w-full max-w-4xl border-collapse text-left text-sm tabular-nums">
        <thead className="text-white/50">
          <tr>
            <th className="border-b border-white/10 py-2 pr-4">rung</th>
            <th className="border-b border-white/10 py-2 pr-4">mode</th>
            <th className="border-b border-white/10 py-2 pr-4">published</th>
            <th className="border-b border-white/10 py-2 pr-4">p50</th>
            <th className="border-b border-white/10 py-2 pr-4">p95</th>
            <th className="border-b border-white/10 py-2 pr-4">budget</th>
            <th className="border-b border-white/10 py-2 pr-4">of budget</th>
            <th className="border-b border-white/10 py-2 pr-4">fps</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const used = row.frameBudgetMs > 0 ? (row.paintP95 / row.frameBudgetMs) * 100 : 0;
            return (
              <tr key={`${row.quality}-${row.mode}`}>
                <td className="border-b border-white/5 py-2 pr-4">{row.quality}</td>
                <td className="border-b border-white/5 py-2 pr-4">{row.mode}</td>
                <td className="border-b border-white/5 py-2 pr-4">{row.published}</td>
                <td className="border-b border-white/5 py-2 pr-4">{row.paintP50}ms</td>
                <td className="border-b border-white/5 py-2 pr-4">{row.paintP95}ms</td>
                <td className="border-b border-white/5 py-2 pr-4">
                  {row.frameBudgetMs}ms @{row.paintRate}
                </td>
                <td
                  className={`border-b border-white/5 py-2 pr-4 ${
                    used > 100 ? 'text-rose-300' : used > 80 ? 'text-amber-300' : 'text-emerald-300'
                  }`}
                >
                  {Math.round(used)}%
                </td>
                <td className="border-b border-white/5 py-2 pr-4">{row.fps}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 className="mt-8 text-sm font-semibold text-white/70">What each rung asks for</h2>
      <ul className="mt-2 space-y-1 text-sm text-white/50">
        {RUNGS.map((quality) => {
          const size = compositeSizeFor(quality);
          const cap = screenCaptureCapFor(quality);
          const cam = resolutionFor(quality);
          const option = QUALITY_OPTIONS.find((o) => o.value === quality);
          return (
            <li key={quality}>
              <span className="text-white/80">{quality}</span> — canvas {size.width}x{size.height},
              camera {cam.width}x{cam.height}, screen cap {cap.width}x{cap.height}, ceiling{' '}
              {(publishBitrateFor(quality) / 1_000_000).toFixed(0)}Mbps
              {option?.desktopOnly ? ', desktop only' : ''}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
