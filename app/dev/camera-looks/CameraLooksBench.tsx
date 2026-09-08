'use client';

/**
 * The look presets, ctx.filter against composite passes, on one frame.
 *
 * THE SOURCE IS SYNTHETIC AND THAT IS DELIBERATE. A photograph would make the
 * comparison prettier and much less useful: what these looks do is move
 * saturation, warmth and contrast, so the frame has to CONTAIN those axes in
 * separable form. A hue sweep shows a hue rotation, a skin row shows what
 * matters on a creator's face, and a grey ramp shows contrast and any colour
 * cast in the one place a cast is unmissable. It also means the bench needs no
 * asset and renders identically on every machine, so the numbers below can be
 * compared across runs.
 *
 * Both columns run the REAL code — `filterCssFor` and `applyLookPasses`, the
 * two branches of the draw loop in createFilteredStream, drawing the same
 * offscreen frame the same way. Nothing here reimplements a look.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  applyLookPasses,
  createFilteredStream,
  filterCssFor,
  filterLabelFor,
  FILTER_ORDER,
  supportsCanvasFilter,
  type FilteredStream,
  type FilterId,
} from '@/lib/live/cameraFilters';

/** The comparison swatches. Small on purpose: six pairs have to fit on screen. */
const COMPARE_W = 220;
const COMPARE_H = 290;

/**
 * The published-track panel runs at a REAL broadcast size instead.
 *
 * 960x1280 is what a 4:3 iPhone sensor publishes under the 1280 long-edge cap,
 * so the frame rate below is measured on the same pixel count the phone
 * actually pushes. Measuring the blend passes on a 220x290 thumbnail would
 * flatter them by a factor of twenty and prove nothing about a broadcast.
 */
const PUBLISH_W = 960;
const PUBLISH_H = 1280;

/** Warm through cool, the range a camera actually points at. */
const SKIN = ['#f4d0b4', '#e0ac86', '#c68863', '#8d5524', '#5a3620'];

function drawSource(ctx: CanvasRenderingContext2D, W = COMPARE_W, H = COMPARE_H) {
  const hueBand = Math.round(H * 0.3);
  const skinBand = Math.round(H * 0.42);

  // A hue sweep: the band that makes a hue-rotate or a saturation change
  // impossible to miss.
  for (let x = 0; x < W; x += 1) {
    ctx.fillStyle = `hsl(${Math.round((x / W) * 360)}, 78%, 55%)`;
    ctx.fillRect(x, 0, 1, hueBand);
  }

  // Skin. The only part of the frame a creator will actually judge.
  const swatch = W / SKIN.length;
  SKIN.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(i * swatch, hueBand, Math.ceil(swatch), skinBand - hueBand);
  });

  // A neutral ramp, black to white. Contrast lives here, and so does any
  // colour cast — a grey that stops being grey is a cast you can see.
  const steps = 8;
  const stepW = W / steps;
  for (let i = 0; i < steps; i += 1) {
    const v = Math.round((i / (steps - 1)) * 255);
    ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
    ctx.fillRect(i * stepW, skinBand, Math.ceil(stepW), H - skinBand);
  }
}

/**
 * The reference frame, built once and shared by every row.
 *
 * Module-level and lazy rather than component state: it is created from
 * `document`, so it cannot exist during a server render, and putting it in
 * state would mean setting that state from an effect — a cascading render for
 * a value that never changes after the first paint.
 */
let sharedSource: HTMLCanvasElement | null = null;

function getSharedSource(): HTMLCanvasElement | null {
  if (sharedSource) return sharedSource;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = COMPARE_W;
  canvas.height = COMPARE_H;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  drawSource(ctx);
  sharedSource = canvas;
  return canvas;
}

interface Delta {
  /** Mean absolute per-pixel difference, 0-255, averaged over RGB. */
  meanAbs: number;
  /** Signed per-channel means. Says WHICH WAY the fallback is off. */
  dR: number;
  dG: number;
  dB: number;
  /** Mean saturation of each, 0-255. The axis the blend passes are worst at. */
  satFilter: number;
  satComposite: number;
}

function compare(a: ImageData, b: ImageData): Delta {
  let abs = 0;
  let dR = 0;
  let dG = 0;
  let dB = 0;
  let satA = 0;
  let satB = 0;
  const px = a.data.length / 4;

  for (let i = 0; i < a.data.length; i += 4) {
    const ar = a.data[i];
    const ag = a.data[i + 1];
    const ab = a.data[i + 2];
    const br = b.data[i];
    const bg = b.data[i + 1];
    const bb = b.data[i + 2];
    abs += Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
    dR += br - ar;
    dG += bg - ag;
    dB += bb - ab;
    // Saturation as max-minus-min: cheap, and the exact thing grayscale(1)
    // and the `saturation` blend are both trying to drive to zero.
    satA += Math.max(ar, ag, ab) - Math.min(ar, ag, ab);
    satB += Math.max(br, bg, bb) - Math.min(br, bg, bb);
  }

  return {
    meanAbs: abs / (px * 3),
    dR: dR / px,
    dG: dG / px,
    dB: dB / px,
    satFilter: satA / px,
    satComposite: satB / px,
  };
}

function LookRow({ id }: { id: FilterId }) {
  const filterRef = useRef<HTMLCanvasElement | null>(null);
  const compositeRef = useRef<HTMLCanvasElement | null>(null);
  const [delta, setDelta] = useState<Delta | null>(null);

  useEffect(() => {
    const source = getSharedSource();
    const filterCanvas = filterRef.current;
    const compositeCanvas = compositeRef.current;
    if (!source || !filterCanvas || !compositeCanvas) return;

    const fx = filterCanvas.getContext('2d', { alpha: false });
    const cx = compositeCanvas.getContext('2d', { alpha: false });
    if (!fx || !cx) return;

    // Branch one of the draw loop: the filter string, then the draw.
    fx.save();
    fx.filter = filterCssFor(id);
    fx.drawImage(source, 0, 0);
    fx.restore();

    // Branch two: the draw, then the passes over it.
    cx.drawImage(source, 0, 0);
    applyLookPasses(cx, id, null);

    setDelta(compare(fx.getImageData(0, 0, COMPARE_W, COMPARE_H), cx.getImageData(0, 0, COMPARE_W, COMPARE_H)));
  }, [id]);

  return (
    <tr>
      <th scope="row" style={{ textAlign: 'left', paddingRight: 16, verticalAlign: 'top' }}>
        <div style={{ fontSize: 15 }}>{filterLabelFor(id)}</div>
        <code style={{ fontSize: 11, opacity: 0.6 }}>{id}</code>
      </th>
      <td>
        <canvas ref={filterRef} width={COMPARE_W} height={COMPARE_H} data-look={id} data-path="filter" />
      </td>
      <td>
        <canvas ref={compositeRef} width={COMPARE_W} height={COMPARE_H} data-look={id} data-path="composite" />
      </td>
      <td style={{ verticalAlign: 'top', paddingLeft: 16, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
        {delta && (
          <div data-metrics={id}>
            <div>Δ mean {delta.meanAbs.toFixed(1)}</div>
            <div style={{ opacity: 0.75 }}>
              R{delta.dR >= 0 ? '+' : ''}
              {delta.dR.toFixed(1)} G{delta.dG >= 0 ? '+' : ''}
              {delta.dG.toFixed(1)} B{delta.dB >= 0 ? '+' : ''}
              {delta.dB.toFixed(1)}
            </div>
            <div style={{ opacity: 0.75 }}>
              sat {delta.satFilter.toFixed(1)} → {delta.satComposite.toFixed(1)}
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * The other half of the question: is the look in the PUBLISHED TRACK?
 *
 * The comparison above proves the passes draw the right picture. It does not
 * prove they draw it onto the canvas that LiveKit encodes — and that
 * distinction is the entire history of this feature. The looks were once a CSS
 * filter on the preview element, which meant the creator saw a look and the
 * audience never did; a fallback that only fixed the preview would recreate
 * exactly that bug on the phones it was written for.
 *
 * So this panel builds a real `createFilteredStream`, hands it a synthetic
 * camera, and reads pixels back OFF THE OUTPUT TRACK — through a <video>
 * element fed by `filtered.previewStream`, which is the same canvas handed to
 * `publishTracks`. Nothing here inspects the canvas directly. If the swatch
 * below is tinted, the tint is in the frames a viewer receives.
 *
 * The zoom and flip controls are here for the same reason: they change what is
 * drawn before the look is applied, and "the look survives them" is a claim
 * about ordering inside the draw loop that is much better measured than
 * reasoned about.
 */
function PublishedTrackPanel() {
  const outputRef = useRef<HTMLVideoElement | null>(null);
  const probeRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<FilteredStream | null>(null);
  const [look, setLook] = useState<FilterId>('warm');
  const [zoom, setZoom] = useState(1);
  const [flipped, setFlipped] = useState(false);
  const [stats, setStats] = useState<{ fps: number; lookMode: string } | null>(null);
  const [sample, setSample] = useState<string>('—');

  useEffect(() => {
    let disposed = false;
    let sourceRaf: number | null = null;

    async function start() {
      // A synthetic camera: a canvas captured as a MediaStream. It has to keep
      // being redrawn — a canvas that stops changing stops producing frames,
      // and a stalled track would look exactly like a broken pipeline.
      const cam = document.createElement('canvas');
      cam.width = PUBLISH_W;
      cam.height = PUBLISH_H;
      const camCtx = cam.getContext('2d', { alpha: false });
      if (!camCtx) return;

      // Redrawn on every animation frame, not on a timer. A captureStream only
      // emits when its canvas changes, so a source painted at 10Hz caps the
      // whole pipeline at 10fps — which is a property of the bench, and would
      // read as the blend passes being ruinously slow.
      const paint = () => {
        drawSource(camCtx, PUBLISH_W, PUBLISH_H);
        sourceRaf = requestAnimationFrame(paint);
      };
      paint();

      const filtered = await createFilteredStream(cam.captureStream(30), look, 30, false);
      if (disposed) {
        filtered.stop();
        return;
      }
      streamRef.current = filtered;

      const video = outputRef.current;
      if (video) {
        video.srcObject = filtered.previewStream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => undefined);
      }
    }

    void start();
    return () => {
      disposed = true;
      if (sourceRaf !== null) cancelAnimationFrame(sourceRaf);
      streamRef.current?.stop();
      streamRef.current = null;
    };
    // Built once. The look, zoom and flip are pushed in through the setters
    // below, which is the point — a look change must not need a new stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    streamRef.current?.setFilter(look);
  }, [look]);
  useEffect(() => {
    streamRef.current?.setZoom(zoom);
  }, [zoom]);
  useEffect(() => {
    streamRef.current?.setFlipped(flipped);
  }, [flipped]);

  /** Read the OUTPUT track, never the canvas behind it. */
  const measure = useCallback(() => {
    const video = outputRef.current;
    const probe = probeRef.current;
    const ctx = probe?.getContext('2d', { alpha: false });
    if (!video || !probe || !ctx || video.videoWidth === 0) return;
    ctx.drawImage(video, 0, 0, probe.width, probe.height);
    // The skin band, which is where a look is judged.
    const d = ctx.getImageData(Math.round(probe.width * 0.3), Math.round(probe.height * 0.36), 1, 1).data;
    setSample(`rgb(${d[0]}, ${d[1]}, ${d[2]})`);
    setStats(streamRef.current?.getStats() ?? null);
  }, []);

  useEffect(() => {
    const timer = setInterval(measure, 500);
    return () => clearInterval(timer);
  }, [measure]);

  return (
    <section style={{ marginTop: 40, paddingTop: 24, borderTop: '1px solid #333' }}>
      <h2 style={{ fontSize: 17 }}>The published track</h2>
      <p style={{ fontSize: 13, opacity: 0.7, maxWidth: 760, lineHeight: 1.5 }}>
        A real <code>createFilteredStream</code> over a synthetic camera. The picture below is its
        OUTPUT track played back through a <code>&lt;video&gt;</code> — the same object that is
        handed to LiveKit — so a look visible here is a look a viewer receives. Change the look,
        the zoom or the flip and it must keep up without the stream being rebuilt.
      </p>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', marginTop: 12 }}>
        <video ref={outputRef} width={COMPARE_W} height={COMPARE_H} style={{ background: '#000' }} data-published />
        <canvas ref={probeRef} width={COMPARE_W} height={COMPARE_H} style={{ display: 'none' }} />
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <div>
            look:{' '}
            <select value={look} onChange={(e) => setLook(e.target.value as FilterId)}>
              {FILTER_ORDER.map((id) => (
                <option key={id} value={id}>
                  {filterLabelFor(id)} ({id})
                </option>
              ))}
            </select>
          </div>
          <div>
            zoom:{' '}
            {[1, 2, 3].map((z) => (
              <button key={z} onClick={() => setZoom(z)} style={{ marginRight: 6, fontWeight: zoom === z ? 700 : 400 }}>
                {z}×
              </button>
            ))}
          </div>
          <div>
            <label>
              <input type="checkbox" checked={flipped} onChange={(e) => setFlipped(e.target.checked)} /> flipped
            </label>
          </div>
          <div style={{ fontFamily: 'ui-monospace, monospace', marginTop: 8 }}>
            <div data-published-mode={stats?.lookMode ?? ''}>path: {stats?.lookMode ?? '…'}</div>
            <div data-published-fps={stats?.fps ?? 0}>fps: {stats?.fps ?? '…'}</div>
            <div data-published-sample={sample}>skin pixel: {sample}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CameraLooksBench() {
  /*
    A client-only fact, read without an effect.

    `supportsCanvasFilter()` touches `document`, so the server has no answer
    and renders null; useSyncExternalStore is the sanctioned way to say that,
    and it hydrates without a mismatch. The subscribe callback is a no-op
    because the answer cannot change while the page is open — it is a property
    of the browser, not of any state.
  */
  const nativeFilter = useSyncExternalStore(
    () => () => {},
    () => supportsCanvasFilter(),
    () => null,
  );

  return (
    <main style={{ padding: 24, background: '#111', color: '#eee', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Camera looks: ctx.filter vs composite passes</h1>
      <p style={{ fontSize: 13, opacity: 0.7, maxWidth: 760, lineHeight: 1.5 }}>
        Left is what desktop publishes today. Right is what a browser without{' '}
        <code>ctx.filter</code> publishes — the same look rebuilt out of blend passes. They are
        meant to read as the same look, not to be identical: Δ mean is the average per-channel
        distance over the whole frame, and <code>sat</code> is mean saturation on each side, which
        is the number that matters for ขาวดำ and วินเทจ.
      </p>
      <p style={{ fontSize: 13, marginBottom: 20 }}>
        This browser&rsquo;s <code>ctx.filter</code>:{' '}
        <strong data-native-filter={String(nativeFilter)}>
          {nativeFilter === null ? '…' : nativeFilter ? 'supported' : 'NOT SUPPORTED'}
        </strong>
        {nativeFilter === false && ' — the left column is not a reference here.'}
      </p>

      <table style={{ borderSpacing: '0 14px' }}>
        <thead>
          <tr style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.6 }}>
            <th style={{ textAlign: 'left' }}>look</th>
            <th style={{ textAlign: 'left' }}>ctx.filter</th>
            <th style={{ textAlign: 'left' }}>composite</th>
            <th style={{ textAlign: 'left', paddingLeft: 16 }}>difference</th>
          </tr>
        </thead>
        <tbody>
          {FILTER_ORDER.map((id) => (
            <LookRow key={id} id={id} />
          ))}
        </tbody>
      </table>

      <PublishedTrackPanel />
    </main>
  );
}
