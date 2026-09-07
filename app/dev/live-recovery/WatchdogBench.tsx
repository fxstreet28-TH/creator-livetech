'use client';

/**
 * The two detectors, against a video that can be broken on demand.
 *
 * A frozen picture over a healthy transport is the failure that started all of
 * this, and it is not something you can wait around for on a real broadcast.
 * So the source here is a canvas captured as a MediaStream: stop drawing to it
 * and the video element keeps its last frame forever while remaining, by every
 * measure the browser exposes, a playing video. That is the bug, reproduced in
 * one button.
 *
 * The negative case matters as much as the positive one. A PAUSED video also
 * produces no frames, for entirely correct reasons — a viewer who pressed
 * pause, or a browser that refused autoplay — and a watchdog that tore the
 * player down underneath them would be a bug wearing a watchdog's clothes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useVideoFrameWatchdog } from '@/lib/live/useVideoFrameWatchdog';
import { useWakeRecheck } from '@/lib/live/useWakeRecheck';

export function WatchdogBench() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const drawingRef = useRef(true);
  const [frozen, setFrozen] = useState(false);
  const [stalls, setStalls] = useState(0);
  const [wakes, setWakes] = useState(0);
  const [lastDetail, setLastDetail] = useState<string>('—');

  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let raf = 0;
    const paint = () => {
      if (drawingRef.current) {
        // Something that changes every frame, so a stalled capture is a
        // stalled picture rather than a static one that merely looks stalled.
        ctx.fillStyle = `hsl(${(Date.now() / 10) % 360}, 70%, 50%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      raf = requestAnimationFrame(paint);
    };
    paint();

    const video = videoRef.current;
    if (video) {
      video.srcObject = canvas.captureStream(30);
      video.muted = true;
      video.playsInline = true;
      void video.play().catch(() => undefined);
    }

    return () => cancelAnimationFrame(raf);
  }, []);

  useVideoFrameWatchdog({
    getVideo: useCallback(() => videoRef.current, []),
    active: true,
    onStall: useCallback((detail: Record<string, unknown>) => {
      setStalls((n) => n + 1);
      setLastDetail(JSON.stringify(detail));
    }, []),
  });

  useWakeRecheck({
    isHealthy: useCallback(() => {
      const video = videoRef.current;
      return !!video && !video.paused && video.readyState >= 2 && drawingRef.current;
    }, []),
    onWake: useCallback(() => setWakes((n) => n + 1), []),
  });

  return (
    <section style={{ marginTop: 32, paddingTop: 20, borderTop: '1px solid #333' }}>
      <h2 style={{ fontSize: 17 }}>Frame watchdog and wake</h2>
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', marginTop: 12 }}>
        <video ref={videoRef} width={240} height={160} style={{ background: '#000' }} data-probe-video />
        <div style={{ fontSize: 13, lineHeight: 2 }}>
          <button
            type="button"
            data-freeze
            onClick={() => {
              drawingRef.current = !drawingRef.current;
              setFrozen(!drawingRef.current);
            }}
          >
            {frozen ? 'resume source' : 'freeze source'}
          </button>{' '}
          <button
            type="button"
            data-pause
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              if (video.paused) void video.play().catch(() => undefined);
              else video.pause();
            }}
          >
            pause / play
          </button>{' '}
          <button
            type="button"
            data-bfcache
            onClick={() => {
              // What a bfcache restore looks like to the page.
              const event = new PageTransitionEvent('pageshow', { persisted: true });
              window.dispatchEvent(event);
            }}
          >
            simulate bfcache restore
          </button>
          <div
            style={{ fontFamily: 'ui-monospace, monospace', marginTop: 10 }}
            data-detectors
            data-stalls={stalls}
            data-wakes={wakes}
            data-frozen={String(frozen)}
          >
            <div>stalls: {stalls}</div>
            <div>wakes: {wakes}</div>
            <div style={{ opacity: 0.6, maxWidth: 420 }}>last: {lastDetail}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
