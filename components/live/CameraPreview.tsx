'use client';

/**
 * The pre-broadcast camera check on /creator/live.
 *
 * Deliberately plain getUserMedia rather than a LiveKit room: nothing should
 * reach LiveKit — and start the meter that bills the platform — until the
 * creator presses the go-live button. The stream this opens is stopped when
 * the component unmounts, which is exactly when the page swaps to the
 * broadcasting state, so the camera is free before CreatorBroadcaster asks
 * for it. Windows Chrome in particular refuses a second open of a camera that
 * is still held.
 *
 * Resolution is requested as `ideal`, not `exact`: a webcam that cannot do
 * 1080p should show a smaller picture, not an OverconstrainedError where a
 * preview ought to be.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Camera, Mic, MicOff, RefreshCw } from 'lucide-react';
import type { BroadcastQuality } from '@/lib/live/types';
import { resolutionFor, thaiForMediaError } from '@/lib/live/livekitClient';

interface CameraPreviewProps {
  quality: BroadcastQuality;
  /** Selected camera. Empty string means "browser default". */
  deviceId: string;
  onDeviceIdChange: (deviceId: string) => void;
  micEnabled: boolean;
  onMicEnabledChange: (enabled: boolean) => void;
  /** Told whether a usable camera track is live, so the form can gate its CTA. */
  onReadyChange?: (ready: boolean) => void;
}

export function CameraPreview({
  quality,
  deviceId,
  onDeviceIdChange,
  micEnabled,
  onMicEnabledChange,
  onReadyChange,
}: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const selectId = useId();

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  /** Bumped to re-run the effect after "ลองใหม่". */
  const [attempt, setAttempt] = useState(0);
  const [level, setLevel] = useState(0);

  // onReadyChange lands in the effect's dependency list, and a parent that
  // passes an inline arrow would otherwise restart the camera on every render.
  const readyRef = useRef(onReadyChange);
  readyRef.current = onReadyChange;

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    async function start() {
      setStarting(true);
      setError(null);

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            width: { ideal: resolutionFor(quality).width },
            height: { ideal: resolutionFor(quality).height },
          },
          audio: true,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[CameraPreview] getUserMedia failed', err);
        setError(thaiForMediaError(err));
        setStarting(false);
        readyRef.current?.(false);
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setStarting(false);
      readyRef.current?.(true);

      // Labels are blank until a permission has been granted at least once,
      // so the picker is filled in AFTER the first successful getUserMedia
      // rather than on mount — a dropdown of "camera 1 / camera 2" is not a
      // choice anyone can make.
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setDevices(all.filter((device) => device.kind === 'videoinput'));
      } catch {
        // A browser that refuses to enumerate still previews fine.
      }
    }

    void start();

    return () => {
      cancelled = true;
      readyRef.current?.(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [deviceId, quality, attempt]);

  // The mic toggle acts on the preview's own track. LiveKit is told separately
  // when the broadcast starts (PublisherOptions.micEnabled), because this
  // stream is gone by then.
  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = micEnabled;
    });
  }, [micEnabled, starting]);

  /**
   * "ทดสอบเสียง" — a peak meter off the live mic track.
   *
   * Web Audio rather than a LiveKit level: there is no room yet. The context
   * is created per attempt and closed on cleanup; leaving one open holds the
   * audio hardware awake for the rest of the session.
   */
  useEffect(() => {
    if (starting || error) return;
    const stream = streamRef.current;
    if (!stream || stream.getAudioTracks().length === 0) return;

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const context = new AudioContextCtor();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;

    const tick = () => {
      analyser.getByteTimeDomainData(buffer);
      let peak = 0;
      for (const sample of buffer) peak = Math.max(peak, Math.abs(sample - 128));
      // /128 normalises to 0..1; the ×2.2 makes speech fill a useful part of
      // the bar instead of hovering near the left edge.
      setLevel(Math.min(1, (peak / 128) * 2.2));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void context.close();
      setLevel(0);
    };
  }, [starting, error]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <section aria-label="ตรวจสอบกล้องและไมโครโฟน" className="min-w-0">
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Muted is not a preference here: an unmuted preview of your own mic
          // is a feedback loop through the laptop speakers.
          muted
          aria-label="ภาพตัวอย่างจากกล้อง"
          className="h-full w-full object-cover"
        />

        {starting && !error && (
          <div className="absolute inset-0 grid place-items-center bg-black/60 text-sm text-white/70">
            กำลังเปิดกล้อง...
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="absolute inset-0 grid place-items-center bg-black/80 px-6 text-center"
          >
            <div>
              <Camera size={28} className="mx-auto text-rose-300" aria-hidden />
              <p className="mt-3 text-sm leading-relaxed text-rose-100">{error}</p>
              <button
                type="button"
                onClick={retry}
                className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.06] px-4 text-sm font-semibold text-white transition hover:bg-white/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                <RefreshCw size={15} aria-hidden />
                ลองใหม่
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-3">
        {devices.length > 1 && (
          <div>
            <label htmlFor={selectId} className="block text-sm font-medium text-white/75">
              เลือกกล้อง
            </label>
            <select
              id={selectId}
              value={deviceId}
              onChange={(event) => onDeviceIdChange(event.target.value)}
              className="mt-2 h-12 w-full rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white focus:border-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              <option value="">กล้องเริ่มต้น</option>
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `กล้อง ${index + 1}`}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <button
            type="button"
            onClick={() => onMicEnabledChange(!micEnabled)}
            aria-pressed={micEnabled}
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
              micEnabled
                ? 'bg-white/10 text-white hover:bg-white/15'
                : 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
            }`}
          >
            {micEnabled ? <Mic size={18} aria-hidden /> : <MicOff size={18} aria-hidden />}
            <span className="sr-only">{micEnabled ? 'ปิดไมโครโฟน' : 'เปิดไมโครโฟน'}</span>
          </button>

          <div className="min-w-0 flex-1">
            <p className="text-xs text-white/55">
              {micEnabled ? 'ทดสอบเสียง — ลองพูดดู' : 'ไมโครโฟนปิดอยู่'}
            </p>
            <div
              role="meter"
              aria-label="ระดับเสียงไมโครโฟน"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
              className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10"
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-purple-400 transition-[width] duration-75"
                style={{ width: `${micEnabled ? Math.round(level * 100) : 0}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
