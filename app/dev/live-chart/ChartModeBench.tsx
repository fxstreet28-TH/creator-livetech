'use client';

/**
 * โหมดกราฟ, measured rather than argued.
 *
 * See ./page.tsx for what D1, D2 and D3 are and why they are separate. This
 * file is the measurement, and its three parts are:
 *
 *   THE SOURCES are canvases captured as tracks — a candlestick chart at a
 *   MONITOR's resolution (2560x1440 by default, the size of the display a
 *   creator shares from) and a face at a webcam's. Synthetic because a monitor
 *   and a webcam are not available in CI, and because a chart drawn to a known
 *   pattern is the only way a pixel read back out of the published frame means
 *   anything.
 *
 *   THE PIPELINE is the shipping one: `createFilteredStream`, `setSecondSource`,
 *   `layoutRects`, the published canvas track. Nothing here reimplements the
 *   composite.
 *
 *   THE ENCODER is real too. A LOOPBACK `RTCPeerConnection` carries the
 *   published canvas track, negotiated H.264 by the same `preferH264` the WHIP
 *   publisher uses, with the same parameters applied by the same
 *   `applyPublishEncoderParams` — so `outbound-rtp` answers D1 about the code
 *   that ships, on a page, without a WHIP server or an iPhone in the room.
 *
 * WHAT A HEADLESS BENCH CANNOT SETTLE, stated up front so no number below is
 * read as more than it is. There is no GPU here: the rasterizer is software and
 * so is the encoder, both several times slower than a creator's laptop, and
 * `encoderImplementation` will read as software whatever the machine could do.
 * The RATIOS between rungs and modes are the finding; the absolute
 * milliseconds are an upper bound.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createFilteredStream, type FilteredStream } from '@/lib/live/cameraFilters';
import {
  CHART_FULL_TOP_RATIO,
  COMPOSITE_FRAME_RATE,
  COMPOSITE_SIZE_1080,
  COMPOSITE_SIZE_720,
  chartPanAnchor,
  compositeSizeFor,
  containRect,
  coverSourceRect,
  layoutRects,
  screenCaptureCapFor,
  screenCapturePlanFor,
  type ChartPan,
  type CompositeLayout,
  type CompositeSize,
} from '@/lib/live/compositeCanvas';
import { publishBitrateFor } from '@/lib/live/constants';
import { applyPublishEncoderParams, readOutboundVideoStats } from '@/lib/live/encoderParams';
import { preferH264 } from '@/lib/live/whipClient';
import { resolutionFor } from '@/lib/live/livekitClient';
import type { BroadcastQuality } from '@/lib/live/types';

/** One assertion, and the numbers behind it. */
interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * The monitor a creator shares from. 2560x1440 is Por's likely display and the
 * one the D2 arithmetic in the PR body is quoted for; 1920x1080 is reported
 * beside it because that is the other common case and the scale factors differ.
 */
const MONITOR = { width: 2560, height: 1440 };
const MONITOR_ALT = { width: 1920, height: 1080 };

/** The webcam, as a desktop opens it. */
const CAMERA = { width: 1280, height: 720 };

/**
 * The 1440p rung under test — NOT a BroadcastQuality, deliberately.
 *
 * F6 asks whether a rung above 1080p is worth shipping. Adding '1440p' to the
 * quality type before the answer is known would mean a DB CHECK constraint, a
 * tier gate and a form option for a rung the bench may be about to rule out.
 * So it is measured as what it actually is — a composite SIZE and a bitrate —
 * and only becomes a rung if the numbers below say it can be one.
 */
const SIZE_1440: CompositeSize = { width: 1440, height: 2560 };
/** Ladder-proportional against 1080p's 9 Mbps at 2.25x the 720p pixels. */
const BITRATE_1440 = 16_000_000;

/**
 * The capture cap each rung asked for BEFORE this change — PR #64's 1280x720,
 * raised to 1920x1080 at the 1080p rung by PR #65.
 *
 * Kept here rather than left in git history because the D3 table is a
 * comparison and a comparison needs both sides computed by the same function.
 */
const BEFORE_CAP: Record<string, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

/** Long enough for the paint percentiles to settle, short enough to sit through. */
const SAMPLE_MS = 5_000;
/** Thrown away before each sample. See the note where it is used. */
const WARMUP_MS = 1_500;
/** Two stats reads this far apart, so `bitrate` is a rate and not a lifetime. */
const ENCODE_SAMPLE_MS = 4_000;

/** The F6 ship gate: p95 at or under this share of the frame budget. */
const RUNG_SHIP_LIMIT = 0.9;

/**
 * The studio's own fallback threshold, quoted so the bench's note and the
 * behaviour it describes cannot drift. See PAINT_BUDGET_LIMIT in
 * components/live/CreatorBroadcaster.
 */
const PAINT_BUDGET_NOTE = 80;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/* ------------------------------------------------------------------ sources */

/**
 * The chart, drawn at the monitor's own resolution.
 *
 * TWO THINGS IN IT ARE LOAD-BEARING RATHER THAN DECORATIVE.
 *
 * The PROBE WICK: a 1px pure-white vertical line at a known fraction of the
 * width, in a band of its own. It is the thinnest thing on a real chart and the
 * first thing a resample destroys, so "did the wick survive?" is checkable by
 * reading one column of the published frame rather than by looking at it.
 *
 * The PRICE AXIS BAND: a solid amber column down the right-hand edge, which is
 * where every trading platform puts its numbers. `cover` anchored right must
 * keep it; `cover` anchored left must lose it. That is the pan control's whole
 * behaviour, in two pixel reads.
 */
const AXIS_BAND = '#c9a227';
/**
 * Where the probe wick sits, as a fraction of the source width.
 *
 * 0.75 rather than the middle, and the number is load-bearing: a right-anchored
 * `cover` crop of a 16:9 source into the 65% slot keeps roughly the rightmost
 * half of the width, so a wick at 0.42 would fall outside the very crop the
 * check exists to measure — which is a bench that tests nothing, not a bench
 * that fails. 0.75 is inside the crop on both a 2560- and a 1920-wide monitor,
 * and clear of the axis band in the rightmost 3%.
 */
const WICK_AT = 0.75;

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

  // The axis labels — the detail that is unreadable at 720p on a phone.
  ctx.fillStyle = '#8b949e';
  ctx.font = `${Math.round(h / 60)}px monospace`;
  for (let i = 0; i < 24; i += 1) {
    ctx.fillText((1.08 + i * 0.0012).toFixed(5), w - Math.round(w / 9), (i + 1) * (h / 25));
  }

  // The price-axis band, hard against the right edge. See AXIS_BAND.
  ctx.fillStyle = AXIS_BAND;
  ctx.fillRect(w - Math.round(w * 0.03), 0, Math.round(w * 0.03), h);

  // The probe wick: 1px, white, in a band with nothing else in it. Static
  // rather than animated, so the column it lands in does not move between the
  // moment the geometry is computed and the moment the frame is read.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.round(w * WICK_AT), Math.round(h * 0.06), 1, Math.round(h * 0.1));
}

/** A face: a subject in the middle, no fine detail. What a webcam costs. */
function drawFace(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  ctx.fillStyle = '#1b2330';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#7c4dff';
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
  const timer = window.setInterval(() => {
    t += 0.15;
    paint(ctx, width, height, t);
  }, 1000 / 30);
  return { stream: canvas.captureStream(30), stop: () => window.clearInterval(timer) };
}

/* ------------------------------------------------------------ reading back */

async function grabFrame(stream: MediaStream): Promise<ImageData | null> {
  const [track] = stream.getVideoTracks();
  if (!track) return null;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await video.play().catch(() => undefined);
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

const luma = ([r, g, b]: [number, number, number]) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Amber-dominant, which on this chart means the price axis and nothing else. */
function isAxisBand(rgb: [number, number, number]): boolean {
  const [r, g, b] = rgb;
  return r > 120 && g > 90 && b < 90 && r > b + 60;
}

/** The brightest pixel in a small horizontal window. The wick, if it survived. */
function peakLuma(frame: ImageData, x: number, y: number, radius: number): number {
  let peak = 0;
  for (let dx = -radius; dx <= radius; dx += 1) {
    peak = Math.max(peak, luma(pixelAt(frame, x + dx, y)));
  }
  return peak;
}

/* ------------------------------------------------------- the encoder (D1) */

interface EncoderRow {
  label: string;
  /** What the canvas being encoded actually is. */
  canvas: string;
  mode: 'camera' | 'chart';
  sending: string;
  fps: number | null;
  kbps: number | null;
  qualityLimitationReason: string | null;
  encoder: string | null;
  codec: string | null;
  /**
   * WHAT THE SENDER ACTUALLY HOLDS, read back off `getParameters()`.
   *
   * The direct evidence that F1's parameters landed, and it is worth more here
   * than the measured bitrate beside it: a loopback has no congestion to
   * discover, so WebRTC's bandwidth estimator ramps from its own floor and the
   * CEILING is never the binding constraint inside a sample window this short.
   * The ceiling is therefore checked where it is a fact — in the parameters —
   * rather than inferred from a rate that was limited by something else.
   */
  ceilingMbps: string;
  degradation: string;
  scaleDown: string;
  /** True when the encoder is sending the canvas at full size. The D1 verdict. */
  fullResolution: boolean;
}

/**
 * Encode a track over a loopback peer connection and report what came out.
 *
 * THE HONEST PART AND THE DISHONEST PART, both worth naming. Honest: the
 * encoder is real, the codec is the one production negotiates, the parameters
 * are applied by production's own function, and `outbound-rtp` is the encoder's
 * own account of itself. Dishonest if read carelessly: a loopback has no
 * uplink, so `qualityLimitationReason: 'bandwidth'` can never appear here and
 * its absence proves nothing about a creator's network. What CAN appear is
 * 'cpu', which is the limitation this bench is actually able to provoke — and
 * which is precisely the one that silently halved a chart under
 * `maintain-framerate`.
 */
async function measureEncoder(
  track: MediaStreamTrack,
  options: {
    label: string;
    canvas: string;
    quality: BroadcastQuality;
    maxFramerate: number;
    chartMode: boolean;
    /** Overrides the rung's ceiling. Only the experimental 1440p rung uses it. */
    maxBitrate?: number;
    expectHeight: number;
  },
): Promise<EncoderRow> {
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  try {
    sender.onicecandidate = (event) => {
      if (event.candidate) void receiver.addIceCandidate(event.candidate);
    };
    receiver.onicecandidate = (event) => {
      if (event.candidate) void sender.addIceCandidate(event.candidate);
    };

    const transceiver = sender.addTransceiver(track, {
      direction: 'sendonly',
      sendEncodings: [
        {
          maxBitrate: options.maxBitrate ?? publishBitrateFor(options.quality, options.chartMode),
          maxFramerate: options.maxFramerate,
        },
      ],
    });
    // The same codec the WHIP publisher offers. An encoder's behaviour under
    // pressure is a property of the codec.
    preferH264(transceiver);

    const offer = await sender.createOffer();
    await sender.setLocalDescription(offer);
    await receiver.setRemoteDescription(offer);
    const answer = await receiver.createAnswer();
    await receiver.setLocalDescription(answer);
    await sender.setRemoteDescription(answer);

    // Production's own function, not a copy of it — which is the point of
    // ./encoderParams existing as a module.
    await applyPublishEncoderParams(transceiver.sender, {
      quality: options.quality,
      maxFramerate: options.maxFramerate,
      chartMode: options.chartMode,
      label: '[bench]',
    });
    if (options.maxBitrate !== undefined) {
      // The experimental rung's ceiling, written after — applyPublishEncoderParams
      // knows only the shipping ladder, and 1440p is not on it yet.
      const params = transceiver.sender.getParameters();
      if (params.encodings?.[0]) {
        params.encodings[0].maxBitrate = options.maxBitrate;
        await transceiver.sender.setParameters(params);
      }
    }

    // Two reads: the first establishes the byte counter, the second turns the
    // difference into a rate.
    await wait(ENCODE_SAMPLE_MS);
    const first = await readOutboundVideoStats(transceiver.sender, null);
    await wait(ENCODE_SAMPLE_MS);
    const stats = await readOutboundVideoStats(transceiver.sender, first);

    const applied = transceiver.sender.getParameters();
    const encoding = applied.encodings?.[0];

    return {
      ceilingMbps:
        encoding?.maxBitrate === undefined
          ? '—'
          : `${(encoding.maxBitrate / 1_000_000).toFixed(2)}`,
      degradation: applied.degradationPreference ?? '—',
      scaleDown:
        encoding?.scaleResolutionDownBy === undefined
          ? '(unset)'
          : String(encoding.scaleResolutionDownBy),
      label: options.label,
      canvas: options.canvas,
      mode: options.chartMode ? 'chart' : 'camera',
      sending: `${stats?.frameWidth ?? '?'}x${stats?.frameHeight ?? '?'}`,
      fps: stats?.framesPerSecond ?? null,
      kbps: stats?.bitrate ? Math.round(stats.bitrate / 1000) : null,
      qualityLimitationReason: stats?.qualityLimitationReason ?? null,
      encoder: stats?.encoderImplementation ?? null,
      codec: stats?.codec ?? null,
      fullResolution: (stats?.frameHeight ?? 0) >= options.expectHeight,
    };
  } finally {
    sender.close();
    receiver.close();
  }
}

/* ------------------------------------------------- the pixel budget (D2/D3) */

interface ScaleRow {
  /** 'before' is the PR #65 chain, kept so the table is a comparison. */
  when: 'before' | 'after';
  quality: string;
  layout: CompositeLayout;
  monitor: string;
  /** What the browser is asked to capture: a cap, or the monitor itself. */
  captured: string;
  /** The chart's box in the published frame. */
  slot: string;
  /** Source pixels actually read per painted frame. */
  sourceRead: string;
  /** Source px per published px. Above 1 is a downscale. */
  scale: number;
  /** How many resamples the picture passes through, monitor to encoder. */
  resamples: number;
  /** Published pixels the chart actually occupies. Black bars excluded. */
  chartPixels: number;
}

/**
 * The whole of D2 and D3, as arithmetic over the shipping pure functions.
 *
 * No canvas and no browser: `layoutRects`, `containRect` and `coverSourceRect`
 * are the same functions the paint loop calls, so a scale factor here is the
 * scale factor a creator gets. That is why they were kept pure.
 */
function scaleRow(
  when: 'before' | 'after',
  qualityLabel: string,
  size: CompositeSize,
  plan: { width: number; height: number } | null,
  layout: CompositeLayout,
  pan: ChartPan,
  monitor: { width: number; height: number },
): ScaleRow {
  // What getDisplayMedia hands back: the monitor, or the cap where the cap is
  // smaller. A cap larger than the monitor never upscales — it is a maximum.
  const captured = plan
    ? {
        width: Math.min(monitor.width, plan.width),
        height: Math.min(monitor.height, plan.height),
      }
    : monitor;
  const capResample = captured.width === monitor.width ? 0 : 1;

  const slot = layoutRects(layout, 'bottom-right', size).screen;
  const covering = layout === 'chartfull';

  if (covering) {
    const src = coverSourceRect(captured.width, captured.height, slot, 1, chartPanAnchor(pan));
    return {
      when,
      quality: qualityLabel,
      layout,
      monitor: `${monitor.width}x${monitor.height}`,
      captured: `${captured.width}x${captured.height}${plan ? '' : ' (native)'}`,
      slot: `${slot.width}x${slot.height}`,
      sourceRead: `${Math.round(src.width)}x${Math.round(src.height)}`,
      scale: Math.round((src.width / slot.width) * 100) / 100,
      resamples: capResample + 1,
      chartPixels: slot.width * slot.height,
    };
  }

  const box = containRect(captured.width, captured.height, slot);
  return {
    when,
    quality: qualityLabel,
    layout,
    monitor: `${monitor.width}x${monitor.height}`,
    captured: `${captured.width}x${captured.height}${plan ? '' : ' (native)'}`,
    slot: `${slot.width}x${slot.height}`,
    sourceRead: `${captured.width}x${captured.height}`,
    scale: box.width > 0 ? Math.round((captured.width / box.width) * 100) / 100 : 0,
    resamples: capResample + 1,
    chartPixels: box.width * box.height,
  };
}

/* ------------------------------------------------------------ paint (F3/F6) */

interface PaintRow {
  /** 'before' paints the PR #65 capture into the PR #65 arrangement. */
  when: 'before' | 'after';
  quality: string;
  canvas: string;
  mode: string;
  paintP50: number;
  paintP95: number;
  frameBudgetMs: number;
  paintRate: number;
  fps: number;
  /** p95 as a share of budget. The number the ship gate is read off. */
  ofBudget: number;
}

interface Result {
  checks: Check[];
  encoder: EncoderRow[];
  scales: ScaleRow[];
  paint: PaintRow[];
  /** The F6 verdict, in words, from the numbers above. */
  rung1440: string;
  finishedAt: string;
}

export function ChartModeBench() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [encoder, setEncoder] = useState<EncoderRow[]>([]);
  const [scales, setScales] = useState<ScaleRow[]>([]);
  const [paint, setPaint] = useState<PaintRow[]>([]);
  const [rung1440, setRung1440] = useState<string>('—');
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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
    setEncoder([]);
    setScales([]);
    setPaint([]);
    setNote(null);

    const found: Check[] = [];
    const encoderRows: EncoderRow[] = [];
    const scaleRows: ScaleRow[] = [];
    const paintRows: PaintRow[] = [];

    /* ------------------------------------------------------------- D2 / D3 */
    // Pure arithmetic, so it runs first and costs nothing: the pixel budget at
    // both rungs, in both the old arrangement and the new one, for both common
    // monitors.
    for (const monitor of [MONITOR, MONITOR_ALT]) {
      for (const quality of ['720p', '1080p'] as BroadcastQuality[]) {
        const size = compositeSizeFor(quality);
        // THE CHAIN AS IT SHIPPED (PR #64/#65): a hard capture cap at every
        // rung, and the share CONTAINED in a half-height slot. Both halves of
        // the blur, computed with the same functions so the comparison is
        // arithmetic rather than narrative.
        scaleRows.push(
          scaleRow('before', quality, size, BEFORE_CAP[quality], 'split', 'right', monitor),
        );
        const plan = screenCapturePlanFor(quality);
        for (const layout of ['split', 'chartfull'] as CompositeLayout[]) {
          scaleRows.push(scaleRow('after', quality, size, plan, layout, 'right', monitor));
        }
      }
      // The experimental rung, on the same terms.
      scaleRows.push(scaleRow('after', '1440p*', SIZE_1440, null, 'chartfull', 'right', monitor));
    }
    setScales([...scaleRows]);

    const chartFullOn2560 = scaleRows.find(
      (row) =>
        row.when === 'after' &&
        row.quality === '1080p' &&
        row.layout === 'chartfull' &&
        row.monitor === '2560x1440',
    );
    const splitOn2560 = scaleRows.find(
      (row) =>
        row.when === 'after' &&
        row.quality === '1080p' &&
        row.layout === 'split' &&
        row.monitor === '2560x1440',
    );
    const beforeOn2560 = scaleRows.find(
      (row) => row.when === 'before' && row.quality === '1080p' && row.monitor === '2560x1440',
    );
    found.push({
      name: 'กราฟเต็ม gives the chart more published pixels than ครึ่ง-ครึ่ง',
      pass:
        !!chartFullOn2560 &&
        !!splitOn2560 &&
        chartFullOn2560.chartPixels > splitOn2560.chartPixels * 1.8,
      detail: chartFullOn2560
        ? `chartfull ${chartFullOn2560.slot} = ${chartFullOn2560.chartPixels.toLocaleString()}px ` +
          `vs split ${splitOn2560?.chartPixels.toLocaleString()}px ` +
          `(${((chartFullOn2560.chartPixels / (splitOn2560?.chartPixels || 1)) * 100 - 100).toFixed(0)}% more)`
        : 'no row',
    });
    found.push({
      name: 'the chart gains pixels and loses a resample against the shipped chain',
      pass:
        !!beforeOn2560 &&
        !!chartFullOn2560 &&
        chartFullOn2560.chartPixels > beforeOn2560.chartPixels &&
        chartFullOn2560.resamples < beforeOn2560.resamples,
      detail: beforeOn2560
        ? `before: ${beforeOn2560.captured} -> ${beforeOn2560.slot} contain, ` +
          `${beforeOn2560.scale}x in ${beforeOn2560.resamples} resamples, ` +
          `${beforeOn2560.chartPixels.toLocaleString()} chart px | ` +
          `after: ${chartFullOn2560?.captured} -> read ${chartFullOn2560?.sourceRead} -> ` +
          `${chartFullOn2560?.slot} cover, ${chartFullOn2560?.scale}x in ` +
          `${chartFullOn2560?.resamples} resample, ${chartFullOn2560?.chartPixels.toLocaleString()} chart px`
        : 'no row',
    });
    found.push({
      name: 'at 1080p the chart is resampled ONCE, and by less than 1.5x',
      pass: !!chartFullOn2560 && chartFullOn2560.resamples === 1 && chartFullOn2560.scale < 1.5,
      detail: chartFullOn2560
        ? `${chartFullOn2560.monitor} -> captured ${chartFullOn2560.captured} -> read ` +
          `${chartFullOn2560.sourceRead} -> slot ${chartFullOn2560.slot}: ` +
          `${chartFullOn2560.scale}x in ${chartFullOn2560.resamples} resample(s)`
        : 'no row',
    });
    setChecks([...found]);

    /* ------------------------------------------------- the composite itself */
    try {
      for (const rung of [
        {
          label: '720p',
          quality: '720p' as BroadcastQuality,
          size: COMPOSITE_SIZE_720,
          when: 'after' as const,
        },
        {
          label: '1080p',
          quality: '1080p' as BroadcastQuality,
          size: COMPOSITE_SIZE_1080,
          when: 'after' as const,
        },
        {
          label: '1440p*',
          quality: '1080p' as BroadcastQuality,
          size: SIZE_1440,
          when: 'after' as const,
        },
        /**
         * THE BASELINE, LAST: the chain exactly as it shipped.
         *
         * The capture cap PR #64/#65 asked for, painted into ครึ่ง-ครึ่ง with
         * `contain`. Without this row every paint number above is a figure with
         * nothing to be compared to, and "did the native capture cost us
         * anything?" stays an opinion. Run last so it cannot warm the cache for
         * the rows being judged.
         */
        {
          label: '720p',
          quality: '720p' as BroadcastQuality,
          size: COMPOSITE_SIZE_720,
          when: 'before' as const,
        },
        {
          label: '1080p',
          quality: '1080p' as BroadcastQuality,
          size: COMPOSITE_SIZE_1080,
          when: 'before' as const,
        },
      ]) {
        const plan =
          rung.when === 'before' ? BEFORE_CAP[rung.label] : screenCapturePlanFor(rung.quality);
        // What the browser would actually hand the composite at this rung: the
        // monitor, or the cap. The experimental rung takes the monitor.
        const captured =
          rung.label === '1440p*' || !plan
            ? MONITOR
            : {
                width: Math.min(MONITOR.width, plan.width),
                height: Math.min(MONITOR.height, plan.height),
              };

        const camera = makeSource(CAMERA.width, CAMERA.height, drawFace);
        const screen = makeSource(captured.width, captured.height, drawChart);
        let filtered: FilteredStream | null = null;

        try {
          // Exactly the call CreatorBroadcaster makes on a desktop broadcast.
          filtered = await createFilteredStream(
            camera.stream,
            'none',
            resolutionFor(rung.quality).frameRate,
            false,
            undefined,
            true,
            rung.size,
          );
          const publish = filtered.publishStream;

          // No `fit` argument: since ScreenFit a shared screen's fit is the
          // CREATOR'S, read per frame, and the caller no longer states it. The
          // 'before' rows say `whole` explicitly below, because that — a
          // `contain` in a half-height slot — is precisely what they exist to
          // measure the cost of.
          await filtered.setSecondSource(screen.stream, { kind: 'screen' });
          filtered.setScreenFit(rung.when === 'before' ? 'whole' : 'fill');
          /**
           * WARM UP BEFORE MEASURING ANYTHING.
           *
           * The first paints after a share mounts include the canvas resize and
           * the screen element's first decodes, and they are several times the
           * steady-state cost. Sampled without this, the FIRST layout in the
           * first rung reads as the most expensive thing in the table purely
           * for being first — which is a measurement artefact that looks
           * exactly like a finding.
           */
          await wait(WARMUP_MS);

          const layouts: CompositeLayout[] =
            rung.when === 'before' ? ['split'] : ['split', 'chartfull'];
          for (const layout of layouts) {
            filtered.setCompositeLayout(layout);
            // Switching layout resets the paint samples (see setPaintRate's
            // note on why a p95 must not mix two rates); a beat here keeps the
            // percentiles about the arrangement being measured.
            await wait(WARMUP_MS);
            await wait(SAMPLE_MS);
            if (cancelled.current) return;
            const stats = filtered.getStats();
            paintRows.push({
              when: rung.when,
              quality: rung.label,
              canvas: `${rung.size.width}x${rung.size.height}`,
              mode: layout,
              paintP50: stats.paintP50,
              paintP95: stats.paintP95,
              frameBudgetMs: stats.frameBudgetMs,
              paintRate: stats.paintRate,
              fps: stats.fps,
              ofBudget:
                stats.frameBudgetMs > 0
                  ? Math.round((stats.paintP95 / stats.frameBudgetMs) * 100)
                  : 0,
            });
            setPaint([...paintRows]);
          }

          /* ------------------------------------------------- pixel checks */
          // Back to กราฟเต็ม for the geometry assertions — it is the preset
          // whose crop, pan and smoothing are what this PR changed.
          filtered.setCompositeLayout('chartfull');
          await wait(600);
          const stats = filtered.getStats();
          const rects = layoutRects('chartfull', 'bottom-right', rung.size);

          if (rung.label === '1080p' && rung.when === 'after') {
            found.push({
              name: 'กราฟเต็ม is 65/35 with even dimensions',
              pass:
                rects.screen.height === Math.round(rung.size.height * CHART_FULL_TOP_RATIO / 2) * 2 &&
                rects.screen.height % 2 === 0 &&
                rects.face !== null &&
                rects.face.height % 2 === 0 &&
                rects.screen.height + (rects.face?.height ?? 0) === rung.size.height,
              detail:
                `chart ${rects.screen.width}x${rects.screen.height}, face ` +
                `${rects.face?.width}x${rects.face?.height}, sum ` +
                `${rects.screen.height + (rects.face?.height ?? 0)} of ${rung.size.height}`,
            });
            found.push({
              name: "the composite reports chart mode with the top slot 'cover'",
              pass: stats.chartMode && stats.secondFit === 'cover' && stats.layout === 'chartfull',
              detail:
                `chartMode=${stats.chartMode} fit=${stats.secondFit} layout=${stats.layout} ` +
                `pan=${stats.chartPan} hint=${stats.publishContentHint}`,
            });
            found.push({
              name: "the published track's contentHint is 'detail' while sharing a screen",
              pass: stats.publishContentHint === 'detail',
              detail: `contentHint=${stats.publishContentHint}`,
            });

            /* -------------------- the pan, read out of the published frame */
            const panFrame = async (pan: ChartPan) => {
              filtered!.setChartPan(pan);
              await wait(500);
              return grabFrame(publish);
            };

            const rightFrame = await panFrame('right');
            const leftFrame = await panFrame('left');
            filtered.setChartPan('right');

            if (!rightFrame || !leftFrame) {
              found.push({
                name: 'frames could be read back out of the published track',
                pass: false,
                detail: 'no frame decoded',
              });
            } else {
              // The axis band is the rightmost 3% of the source. Anchored
              // right it must be at the slot's right edge; anchored left it
              // must be gone entirely.
              const midY = rects.screen.y + rects.screen.height / 2;
              const rightEdge = pixelAt(rightFrame, rects.screen.x + rects.screen.width - 4, midY);
              const leftPanEdge = pixelAt(leftFrame, rects.screen.x + rects.screen.width - 4, midY);
              found.push({
                name: 'pan ขวา keeps the price axis in frame; pan ซ้าย crops it away',
                pass: isAxisBand(rightEdge) && !isAxisBand(leftPanEdge),
                detail:
                  `right-anchored edge rgb(${rightEdge.join(',')}) axis=${isAxisBand(rightEdge)}, ` +
                  `left-anchored edge rgb(${leftPanEdge.join(',')}) axis=${isAxisBand(leftPanEdge)}`,
              });

              // No bars: `cover` fills the slot corner to corner, so neither
              // side edge may be the canvas's own black.
              const leftInside = pixelAt(rightFrame, rects.screen.x + 2, midY);
              found.push({
                name: 'the chart fills its slot edge to edge — no letterbox inside it',
                pass: luma(leftInside) > 8 && luma(rightEdge) > 8,
                detail: `left edge rgb(${leftInside.join(',')}), right edge rgb(${rightEdge.join(',')})`,
              });

              /* ------------------ the wick: did 1px survive the resample? */
              const src = coverSourceRect(
                captured.width,
                captured.height,
                rects.screen,
                1,
                chartPanAnchor('right'),
              );
              const wickSourceX = Math.round(captured.width * WICK_AT);
              const inCrop = wickSourceX >= src.x && wickSourceX <= src.x + src.width;
              const wickX =
                rects.screen.x + ((wickSourceX - src.x) / src.width) * rects.screen.width;
              const wickY = rects.screen.y + rects.screen.height * 0.11;
              const peak = peakLuma(rightFrame, wickX, wickY, 3);
              const ground = luma(pixelAt(rightFrame, wickX + 40, wickY));
              found.push({
                name: 'a 1px candle wick survives the crop as a visible line',
                pass: inCrop && peak > ground + 60,
                detail: inCrop
                  ? `wick at source x=${wickSourceX} -> published x=${Math.round(wickX)}: ` +
                    `peak luma ${Math.round(peak)} against ground ${Math.round(ground)} ` +
                    `(source ${captured.width}x${captured.height} read as ` +
                    `${Math.round(src.width)}x${Math.round(src.height)})`
                  : `the probe wick at ${WICK_AT} of the width falls outside the right-anchored crop`,
              });
            }
          }

          /* ------------------------------------------------- D1: the encoder */
          const [publishTrack] = publish.getVideoTracks();
          if (publishTrack) {
            if (rung.when === 'before') {
              // The baseline rows are about PAINT cost. Encoding them again
              // would measure the same parameters twice and add a minute to
              // the run for nothing.
            } else if (rung.label === '1440p*') {
              encoderRows.push(
                await measureEncoder(publishTrack, {
                  label: '1440p* chart mode (experimental)',
                  canvas: `${rung.size.width}x${rung.size.height}`,
                  quality: '1080p',
                  maxFramerate: COMPOSITE_FRAME_RATE,
                  chartMode: true,
                  maxBitrate: Math.round(BITRATE_1440 * 1.5),
                  expectHeight: rung.size.height,
                }),
              );
            } else {
              // BEFORE and AFTER, on the same canvas, back to back: the only
              // difference between the two rows is the parameters, which is
              // what makes them comparable.
              encoderRows.push(
                await measureEncoder(publishTrack, {
                  label: `${rung.label} camera params (PR #63)`,
                  canvas: `${rung.size.width}x${rung.size.height}`,
                  quality: rung.quality,
                  maxFramerate: COMPOSITE_FRAME_RATE,
                  chartMode: false,
                  expectHeight: rung.size.height,
                }),
              );
              if (cancelled.current) return;
              encoderRows.push(
                await measureEncoder(publishTrack, {
                  label: `${rung.label} โหมดกราฟ`,
                  canvas: `${rung.size.width}x${rung.size.height}`,
                  quality: rung.quality,
                  maxFramerate: COMPOSITE_FRAME_RATE,
                  chartMode: true,
                  expectHeight: rung.size.height,
                }),
              );
            }
            setEncoder([...encoderRows]);
          }

          await filtered.setSecondSource(null);
          await wait(400);
          const afterStats = filtered.getStats();
          if (rung.label === '1080p' && rung.when === 'after') {
            found.push({
              name: "stopping the share puts the hint back to 'motion'",
              pass: afterStats.publishContentHint === 'motion' && !afterStats.chartMode,
              detail:
                `contentHint=${afterStats.publishContentHint} chartMode=${afterStats.chartMode} ` +
                `paintRate=${afterStats.paintRate}`,
            });
          }
        } finally {
          filtered?.stop();
          camera.stop();
          screen.stop();
          camera.stream.getTracks().forEach((track) => track.stop());
          screen.stream.getTracks().forEach((track) => track.stop());
        }
        setChecks([...found]);
      }

      /* ------------------------------------------------ D1 and F6 verdicts */
      const chart1080 = encoderRows.find((row) => row.label === '1080p โหมดกราฟ');
      const camera1080 = encoderRows.find((row) => row.label === '1080p camera params (PR #63)');
      found.push({
        name: 'โหมดกราฟ publishes the canvas at full height — no silent downscale',
        pass: !!chart1080?.fullResolution,
        detail: chart1080
          ? `chart mode sending ${chart1080.sending} (limit ${chart1080.qualityLimitationReason}), ` +
            `camera params sending ${camera1080?.sending} ` +
            `(limit ${camera1080?.qualityLimitationReason}) — encoder ${chart1080.encoder}`
          : 'no encoder row',
      });

      /**
       * DID THE NATIVE CAPTURE COST THE EXISTING PRESETS ANYTHING?
       *
       * The honest risk in F3: กราฟเต็ม reads a CROP and is cheaper, but the
       * other three `contain` the whole surface, and at 1080p that surface is
       * now the monitor rather than a 1920x1080 downscale of it. This is the
       * row that says by how much — and the studio's answer to it is the paint
       * budget check, which re-runs on a layout change and caps the capture
       * when a `contain` preset cannot afford the frame.
       */
      const splitBefore = paintRows.find(
        (row) => row.when === 'before' && row.quality === '1080p' && row.mode === 'split',
      );
      const splitAfter = paintRows.find(
        (row) => row.when === 'after' && row.quality === '1080p' && row.mode === 'split',
      );
      const chartAfter = paintRows.find(
        (row) => row.when === 'after' && row.quality === '1080p' && row.mode === 'chartfull',
      );
      found.push({
        name: 'กราฟเต็ม is cheaper to paint than the contained arrangement it replaces',
        pass: !!chartAfter && !!splitAfter && chartAfter.paintP95 <= splitAfter.paintP95,
        detail:
          `1080p: chartfull p95 ${chartAfter?.paintP95}ms (${chartAfter?.ofBudget}%) vs ` +
          `split p95 ${splitAfter?.paintP95}ms (${splitAfter?.ofBudget}%) on the same native ` +
          `capture; the shipped chain's split was ${splitBefore?.paintP95}ms ` +
          `(${splitBefore?.ofBudget}%) off a ${BEFORE_CAP['1080p'].width}x` +
          `${BEFORE_CAP['1080p'].height} capture. A contain preset over ` +
          `${PAINT_BUDGET_NOTE}% is what the studio's paint-budget check caps back.`,
      });

      const p95_1440 = paintRows.find(
        (row) => row.quality === '1440p*' && row.mode === 'chartfull',
      );
      const p95_1080 = paintRows.find(
        (row) =>
          row.when === 'after' && row.quality === '1080p' && row.mode === 'chartfull',
      );
      const ships = !!p95_1440 && p95_1440.ofBudget <= RUNG_SHIP_LIMIT * 100;
      const verdict = p95_1440
        ? `1440p chart-full paint p95 ${p95_1440.paintP95}ms = ${p95_1440.ofBudget}% of the ` +
          `${p95_1440.frameBudgetMs}ms budget (1080p: ${p95_1080?.paintP95}ms = ` +
          `${p95_1080?.ofBudget}%). Gate is <=${RUNG_SHIP_LIMIT * 100}%. ` +
          `${ships ? 'SHIP' : 'DO NOT SHIP'} the rung.`
        : 'not measured';
      setRung1440(verdict);
      found.push({
        name: 'the 1440p rung is judged against the paint budget, not assumed',
        pass: !!p95_1440,
        detail: verdict,
      });
      setChecks([...found]);

      const result: Result = {
        checks: found,
        encoder: encoderRows,
        scales: scaleRows,
        paint: paintRows,
        rung1440: verdict,
        finishedAt: new Date().toISOString(),
      };
      (window as unknown as { __chartResult?: Result }).__chartResult = result;
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setNote(message);
      (window as unknown as { __chartResult?: Result }).__chartResult = {
        checks: [...found, { name: 'the bench ran to completion', pass: false, detail: message }],
        encoder: encoderRows,
        scales: scaleRows,
        paint: paintRows,
        rung1440: 'not reached',
        finishedAt: new Date().toISOString(),
      };
    } finally {
      setRunning(false);
    }
  }, []);

  // `?auto=1` — the headless driver's entry point. A human opening the page
  // presses the button instead.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('auto') !== '1') return;
    // On a timeout rather than inline: `run` sets state on its first line, and
    // a synchronous setState inside an effect is a cascading render (and a
    // lint error). Same shape as /dev/live-dualcam.
    const timer = window.setTimeout(() => void run(), 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  const failures = checks.filter((check) => !check.pass).length;

  return (
    <main className="min-h-dvh bg-[#0a0a15] px-6 py-8 text-white">
      <h1 className="text-xl font-bold">โหมดกราฟ — is the chart reaching the viewer?</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/60">
        The real pipeline with a synthetic {MONITOR.width}x{MONITOR.height} chart as the shared
        screen and a synthetic webcam as the camera, encoded over a loopback peer connection with
        the parameters the WHIP publisher applies. A browser rasterizing and encoding in software
        (headless, or a machine with no GPU) reads several times slower than a creator&apos;s
        laptop, so treat the RATIOS between rungs and modes as the finding and the absolute
        milliseconds as an upper bound.
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

      <h2 className="mt-8 text-sm font-semibold text-white/70">
        D1 — what the encoder is actually sending
      </h2>
      <table className="mt-2 w-full max-w-5xl border-collapse text-left text-sm tabular-nums">
        <thead className="text-white/50">
          <tr>
            {[
              'params',
              'canvas',
              'sending',
              'fps',
              'ceiling',
              'degradation',
              'scaleDown',
              'bitrate',
              'limit',
              'codec',
            ].map((head) => (
              <th key={head} className="border-b border-white/10 py-2 pr-4">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {encoder.map((row) => (
            <tr key={row.label}>
              <td className="border-b border-white/5 py-2 pr-4">{row.label}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.canvas}</td>
              <td
                className={`border-b border-white/5 py-2 pr-4 ${
                  row.fullResolution ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {row.sending}
              </td>
              <td className="border-b border-white/5 py-2 pr-4">{row.fps ?? '—'}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.ceilingMbps}Mbps</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.degradation}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.scaleDown}</td>
              <td className="border-b border-white/5 py-2 pr-4">
                {row.kbps ? `${row.kbps}kbps` : '—'}
              </td>
              <td className="border-b border-white/5 py-2 pr-4">
                {row.qualityLimitationReason ?? '—'}
              </td>
              <td className="border-b border-white/5 py-2 pr-4">{row.codec ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-8 text-sm font-semibold text-white/70">
        D2 / D3 — pixels the chart gets, and how many times it is resampled
      </h2>
      <table className="mt-2 w-full max-w-5xl border-collapse text-left text-sm tabular-nums">
        <thead className="text-white/50">
          <tr>
            {['when', 'rung', 'layout', 'monitor', 'captured', 'read', 'slot', 'scale', 'resamples', 'chart px'].map(
              (head) => (
                <th key={head} className="border-b border-white/10 py-2 pr-4">
                  {head}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {scales.map((row) => (
            <tr key={`${row.when}-${row.quality}-${row.layout}-${row.monitor}`}>
              <td className="border-b border-white/5 py-2 pr-4">{row.when}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.quality}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.layout}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.monitor}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.captured}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.sourceRead}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.slot}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.scale}x</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.resamples}</td>
              <td className="border-b border-white/5 py-2 pr-4">
                {row.chartPixels.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-8 text-sm font-semibold text-white/70">
        Paint cost against the {Math.round((1000 / COMPOSITE_FRAME_RATE) * 10) / 10}ms budget
      </h2>
      <table className="mt-2 w-full max-w-4xl border-collapse text-left text-sm tabular-nums">
        <thead className="text-white/50">
          <tr>
            {['when', 'rung', 'canvas', 'layout', 'p50', 'p95', 'budget', 'of budget', 'fps'].map((head) => (
              <th key={head} className="border-b border-white/10 py-2 pr-4">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paint.map((row) => (
            <tr key={`${row.when}-${row.quality}-${row.mode}`}>
              <td className="border-b border-white/5 py-2 pr-4">{row.when}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.quality}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.canvas}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.mode}</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.paintP50}ms</td>
              <td className="border-b border-white/5 py-2 pr-4">{row.paintP95}ms</td>
              <td className="border-b border-white/5 py-2 pr-4">
                {row.frameBudgetMs}ms @{row.paintRate}
              </td>
              <td
                className={`border-b border-white/5 py-2 pr-4 ${
                  row.ofBudget > 100
                    ? 'text-rose-300'
                    : row.ofBudget > 80
                      ? 'text-amber-300'
                      : 'text-emerald-300'
                }`}
              >
                {row.ofBudget}%
              </td>
              <td className="border-b border-white/5 py-2 pr-4">{row.fps}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-8 text-sm font-semibold text-white/70">F6 — the 1440p rung</h2>
      <p className="mt-2 max-w-3xl text-sm text-white/60">{rung1440}</p>

      <h2 className="mt-8 text-sm font-semibold text-white/70">
        Checks{' '}
        {checks.length > 0 && (
          <span className={failures ? 'text-rose-300' : 'text-emerald-300'}>
            — {failures ? `${failures} of ${checks.length} failed` : `all ${checks.length} passed`}
          </span>
        )}
      </h2>
      <ul className="mt-2 max-w-4xl space-y-2 text-sm">
        {checks.map((check) => (
          <li key={check.name} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <span className={check.pass ? 'text-emerald-300' : 'text-rose-300'}>
              {check.pass ? 'PASS' : 'FAIL'}
            </span>{' '}
            {check.name}
            <div className="mt-1 text-xs text-white/45">{check.detail}</div>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-sm font-semibold text-white/70">What each rung asks for</h2>
      <ul className="mt-2 space-y-1 text-sm text-white/50">
        {(['720p', '1080p'] as BroadcastQuality[]).map((quality) => {
          const size = compositeSizeFor(quality);
          const plan = screenCapturePlanFor(quality);
          return (
            <li key={quality}>
              <span className="text-white/80">{quality}</span> — canvas {size.width}x{size.height},
              capture {plan ? `max ${plan.width}x${plan.height}` : 'native (uncapped)'}, ceiling{' '}
              {(publishBitrateFor(quality) / 1_000_000).toFixed(1)}Mbps →{' '}
              {(publishBitrateFor(quality, true) / 1_000_000).toFixed(1)}Mbps in โหมดกราฟ
            </li>
          );
        })}
        <li>
          <span className="text-white/80">1440p*</span> — experimental, canvas {SIZE_1440.width}x
          {SIZE_1440.height}, ceiling {(BITRATE_1440 / 1_000_000).toFixed(0)}Mbps →{' '}
          {((BITRATE_1440 * 1.5) / 1_000_000).toFixed(0)}Mbps in โหมดกราฟ; fallback cap{' '}
          {screenCaptureCapFor().width}x{screenCaptureCapFor().height}
        </li>
      </ul>
    </main>
  );
}
