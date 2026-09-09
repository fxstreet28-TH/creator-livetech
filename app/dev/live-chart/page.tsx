/**
 * /dev/live-chart — โหมดกราฟ: is a shared chart actually reaching the viewer?
 *
 * THE QUESTION THIS PAGE EXISTS FOR. A creator shares a TradingView window,
 * the broadcast publishes, and the chart is SOFT on a phone — candle wicks
 * smear, axis prices are illegible. "Soft" is not actionable; three numbers
 * are, and they are independent of each other:
 *
 *   D1  what resolution is the ENCODER actually sending? A sender set to
 *       `maintain-framerate` may quietly drop from 1080x1920 to 540x960 under
 *       CPU or bandwidth pressure and nothing in the UI says so. Answered by
 *       a LOOPBACK peer connection here — a real RTCPeerConnection carrying
 *       the real published canvas track — and read out of `outbound-rtp`.
 *   D2  how many pixels does the CHART get in the published frame? Answered
 *       from `layoutRects` plus the fit rule, as a monitor-px → published-px
 *       scale factor.
 *   D3  how many times is the picture RESAMPLED between the monitor and the
 *       encoder, and at what quality? Answered by pixel-sampling the published
 *       frame and by the capture cap the rung asks for.
 *
 * WHAT IS SYNTHETIC AND WHAT IS REAL. Both sources are canvases captured as
 * tracks — a candlestick chart at a monitor's resolution, a face at a webcam's
 * — because a webcam and a monitor are not available in CI and a chart is the
 * content the whole question is about. Everything downstream is the shipping
 * pipeline: `createFilteredStream`, `setSecondSource`, `layoutRects`, the
 * published canvas track, and a peer connection encoding it.
 *
 * WHAT A HEADLESS BENCH CANNOT ANSWER. It has no GPU, so its encoder is
 * software and its paint is a software rasterizer — both several times slower
 * than a creator's laptop, and `encoderImplementation` will read as software
 * whatever the machine could do. The RATIOS between rungs and modes are the
 * finding; the absolute milliseconds are an upper bound. Where a check depends
 * on hardware (the 1440p rung's viability) it is reported, not asserted.
 *
 * `?auto=1` runs everything on load and leaves the result on
 * `window.__chartResult` for scripts/dev-bench-chart.mjs to read over CDP.
 *
 * WHY THE GATE IS IN A SERVER COMPONENT: `VERCEL_ENV` is not `NEXT_PUBLIC_`,
 * so a reference to it inside a client component is replaced with `undefined`
 * at build time — and `undefined !== 'production'` is TRUE, which would have
 * opened this page on production while looking exactly like a gate that
 * worked. Same reasoning, same shape, as the other /dev pages.
 */

import { notFound } from 'next/navigation';
import { ChartModeBench } from './ChartModeBench';

export default function DevLiveChartPage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return <ChartModeBench />;
}
