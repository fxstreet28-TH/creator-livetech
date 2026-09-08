'use client';

/**
 * The thin layer between this app and `hls.js`.
 *
 * Same split as lib/live/livekitClient.ts, and for the same reason: the player
 * component stays React and the streaming library stays in one file. This is
 * the only file in the app that imports hls.js.
 *
 * WHAT THE VIEWER IS ACTUALLY PLAYING
 *
 * A Bunny LL-HLS playlist — `https://<cdn>/live/<stream-id>/live.m3u8` — fed
 * by the LiveKit egress pushing the creator's room into Bunny over RTMP. There
 * are two consequences for playback that a VOD player never has to think
 * about, and both are handled below:
 *
 *  1. The manifest does not exist until the first frames reach Bunny. A viewer
 *     who opens the page while the creator is still connecting gets a 404, and
 *     that is a NORMAL state ("waiting"), not an error. It is retried.
 *  2. Live latency is a moving target. Sitting three segments back is safe and
 *     slow; sitting one back is fast and stalls on the first hiccup. That
 *     choice is the session's `latency_mode`, decided by the creator's setup
 *     and applied here.
 */

import Hls, { type ErrorData, type HlsConfig } from 'hls.js';
import type { LatencyMode } from './types';

/** What the player is doing, as the UI needs to describe it. */
export type HlsPhase = 'loading' | 'waiting' | 'playing' | 'error';

/**
 * WHY a phase is not 'playing'. The distinction the self-healing ladder is
 * built on.
 *
 * 'manifest_missing' is the CREATOR not being on air yet — the row says live
 * from the moment the egress starts, and Bunny needs a few seconds of RTMP
 * before it writes a playlist. It is the single most common reason this screen
 * shows no picture and it is not a fault on the viewer's device. Everything
 * else here is, or may be, and is worth escalating through.
 *
 * Getting this wrong in either direction is expensive: treat a missing
 * manifest as a device fault and every viewer who arrives thirty seconds early
 * gets their page reloaded for nothing; treat a wedged decoder as a missing
 * manifest and the viewer sits on a spinner for two minutes while the ladder
 * that would have fixed it never runs.
 */
export type HlsFailureReason =
  | 'manifest_missing'
  | 'cdn_refused'
  | 'network'
  | 'media'
  | 'unsupported'
  | 'unknown';

/**
 * hls.js tuning per latency mode.
 *
 * `liveSyncDurationCount` is how many target-durations back from the live edge
 * playback sits, and it is the whole latency/robustness dial:
 *
 *   ultra_low     1 segment back. ~2s, and the first dropped segment stalls.
 *   low_latency   2 back. ~2-4s, the default, and what the cost model assumes.
 *   standard      the library's own defaults plus a longer window — the
 *                 fallback for a viewer on a connection that cannot hold the
 *                 live edge, and the thing to switch a stream to when it
 *                 stutters rather than giving up on LL-HLS entirely.
 *
 * `backBufferLength: 8` everywhere: a live viewer does not scrub backwards,
 * and an unbounded back buffer on a 60-minute broadcast is a memory leak on a
 * phone — which is where 70% of this audience is.
 *
 * THE FORWARD BUFFER IS THE OTHER HALF OF THE LATENCY, and until 2026-09-08 it
 * was left at the library's defaults — `maxBufferLength: 30`, `maxMaxBuffer
 * Length: 600`. `liveSyncDurationCount` only decides where playback STARTS
 * relative to the live edge; the forward buffer decides how far hls.js is
 * willing to run ahead fetching, and a player holding 30s of segments drifts
 * back to the end of what it holds after any hiccup instead of catching up.
 * On the origin path (1s fmp4 segments, hlsSegmentCount 4 on origin-sg-1) that
 * was measured at 8-15s behind the broadcaster with the CDN only accounting
 * for ~4s of it. Capping the forward buffer is what closes the rest.
 *
 * It also removes the state PR #52's ladder was built to dig out of: a large
 * forward buffer plus a dropped segment leaves hls.js buffered on BOTH sides of
 * a hole, stalled between ranges, which the ladder can only fix by rebuilding
 * the player. The ladder stays as the safety net; this stops it being the
 * primary path.
 *
 * 'standard' keeps a deep forward buffer on purpose — it is the fallback for a
 * viewer whose connection cannot hold the live edge at all, so trading latency
 * for segments in hand is the entire point of that rung.
 */
export function hlsConfigFor(mode: LatencyMode): Partial<HlsConfig> {
  const base: Partial<HlsConfig> = {
    backBufferLength: 8,
    maxBufferLength: 6,
    maxMaxBufferLength: 10,
    // Catch up to the live edge by playing slightly fast rather than by
    // seeking, which would drop frames and audio in the middle of a sentence.
    maxLiveSyncPlaybackRate: 1.5,
  };

  if (mode === 'standard') {
    return {
      ...base,
      // Deliberately NOT the capped forward buffer above: this rung exists to
      // ride out a connection that stutters, and it cannot do that on 6s.
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      lowLatencyMode: false,
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 8,
    };
  }
  if (mode === 'ultra_low') {
    return { ...base, lowLatencyMode: true, liveSyncDurationCount: 1, liveMaxLatencyDurationCount: 3 };
  }
  return { ...base, lowLatencyMode: true, liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5 };
}

/** True when the browser can play HLS without hls.js — i.e. Safari, incl. iOS. */
export function hasNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/**
 * How long to keep retrying a manifest that is not there yet.
 *
 * Generous, because the honest reading of a missing manifest is "the creator
 * has not started pushing frames", and a viewer who opened the page thirty
 * seconds early should not be told the stream is broken. Beyond this the
 * session is genuinely not arriving and the UI says so.
 */
const MANIFEST_RETRY_LIMIT = 40;
const MANIFEST_RETRY_DELAY_MS = 3_000;

/** How long the retry budget above adds up to, for the copy on screen. */
export const MANIFEST_RETRY_BUDGET_MS = MANIFEST_RETRY_LIMIT * MANIFEST_RETRY_DELAY_MS;

export interface HlsAttachOptions {
  video: HTMLVideoElement;
  playbackUrl: string;
  latencyMode: LatencyMode;
  /** `reason` is only meaningful when the phase is not 'playing'. */
  onPhaseChange: (phase: HlsPhase, reason?: HlsFailureReason) => void;
  /** Thai, renderable. Only called with phase 'error'. */
  onError: (message: string) => void;
  /** Fired when the browser refused to start audio without a gesture. */
  onAudioBlocked: (blocked: boolean) => void;
  /**
   * The browser refused to play AT ALL, even muted — iOS Low Power Mode is the
   * usual cause.
   *
   * Reported separately from onAudioBlocked, which fires either way, because
   * the two mean opposite things to the recovery ladder. A refused autoplay is
   * a WORKING stream the browser is deliberately not advancing; it needs a
   * tap, not a reconnect, and certainly not a page reload. Without this signal
   * the native path — which only reaches 'playing' when the element actually
   * plays — would be indistinguishable from a dead connection, and every iOS
   * viewer in Low Power Mode would have their page reloaded on a timer.
   */
  onAutoplayRefused?: (refused: boolean) => void;
}

export interface HlsHandle {
  /** Un-mute after a user gesture. Returns false if the browser still refused. */
  unmute: () => Promise<boolean>;
  /** Jump back to the live edge, e.g. after the tab was backgrounded. */
  seekToLive: () => void;
  destroy: () => void;
}

/**
 * Autoplay, the way it actually works on a phone.
 *
 * Every mobile browser refuses to autoplay audio without a gesture, and most
 * refuse video with sound entirely. Starting MUTED gets the picture moving
 * immediately, which is the difference between "the stream is live" and "the
 * page is broken"; the UI then offers one tap to turn sound on. Starting
 * unmuted and hoping would show a stopped video to most of this audience.
 */
async function startMuted(
  video: HTMLVideoElement,
  onAudioBlocked: (b: boolean) => void,
  onAutoplayRefused?: (refused: boolean) => void,
) {
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
    onAudioBlocked(true);
    onAutoplayRefused?.(false);
  } catch {
    // Even muted autoplay can be refused (Low Power Mode on iOS, for one).
    // The player renders its own controls, so the viewer still has a way in.
    onAudioBlocked(true);
    onAutoplayRefused?.(true);
  }
}

/**
 * Attach a live HLS stream to a <video> element.
 *
 * Returns a handle whose `destroy` MUST be called: hls.js keeps timers, a
 * MediaSource and network requests alive, and an undestroyed instance keeps
 * pulling segments — and billing bandwidth — after the component is gone.
 */
export function attachHlsStream(options: HlsAttachOptions): HlsHandle {
  const {
    video,
    playbackUrl,
    latencyMode,
    onPhaseChange,
    onError,
    onAudioBlocked,
    onAutoplayRefused,
  } = options;

  let destroyed = false;
  let manifestRetries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- Safari, which plays HLS itself -------------------------------------
  //
  // Preferred over hls.js where available: native playback on iOS is hardware
  // decoded and materially kinder to the battery, and iOS Safari is the single
  // biggest slice of this audience. hls.js is used only where the browser
  // cannot.
  if (!Hls.isSupported()) {
    if (!hasNativeHls(video)) {
      onPhaseChange('error', 'unsupported');
      onError('เบราว์เซอร์นี้ไม่รองรับการเล่นไลฟ์ กรุณาลองเบราว์เซอร์อื่น');
      return { unmute: async () => false, seekToLive: () => {}, destroy: () => {} };
    }

    /**
     * Safari reports one number for everything, so this is the best signal
     * available on the path most of this audience is on.
     *
     * SRC_NOT_SUPPORTED is what a 404 playlist looks like here — the source
     * could not be loaded or parsed — and it is the "creator is not on air"
     * case. DECODE is the opposite and the interesting one: bytes arrived and
     * the decoder would not take them, which is the wedged media stack a
     * device reboot cures and the ladder now tries to cure instead.
     */
    const nativeReason = (): HlsFailureReason => {
      switch (video.error?.code) {
        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
          return 'manifest_missing';
        case MediaError.MEDIA_ERR_NETWORK:
          return 'network';
        case MediaError.MEDIA_ERR_DECODE:
          return 'media';
        default:
          return 'unknown';
      }
    };

    const onNativeError = () => {
      if (destroyed) return;
      const reason = nativeReason();
      // Safari does not distinguish "not started yet" from "gone", so the
      // manifest is retried on the same budget hls.js gets.
      if (manifestRetries < MANIFEST_RETRY_LIMIT) {
        manifestRetries += 1;
        onPhaseChange('waiting', reason);
        retryTimer = setTimeout(() => {
          if (destroyed) return;
          video.src = playbackUrl;
          void video.load();
        }, MANIFEST_RETRY_DELAY_MS);
        return;
      }
      onPhaseChange('error', reason);
      onError('เชื่อมต่อไลฟ์ไม่สำเร็จ กรุณาลองใหม่');
    };

    const onPlaying = () => {
      manifestRetries = 0;
      onPhaseChange('playing');
    };

    video.addEventListener('error', onNativeError);
    video.addEventListener('playing', onPlaying);
    video.src = playbackUrl;
    void startMuted(video, onAudioBlocked, onAutoplayRefused);

    return {
      unmute: async () => {
        video.muted = false;
        try {
          await video.play();
          onAudioBlocked(false);
          onAutoplayRefused?.(false);
          return true;
        } catch {
          video.muted = true;
          return false;
        }
      },
      seekToLive: () => {
        const seekable = video.seekable;
        if (seekable.length > 0) video.currentTime = seekable.end(seekable.length - 1);
      },
      destroy: () => {
        destroyed = true;
        if (retryTimer) clearTimeout(retryTimer);
        video.removeEventListener('error', onNativeError);
        video.removeEventListener('playing', onPlaying);
        video.removeAttribute('src');
        video.load();
      },
    };
  }

  // ---- Everywhere else ----------------------------------------------------
  const hls = new Hls(hlsConfigFor(latencyMode));

  const load = () => {
    if (destroyed) return;
    hls.loadSource(playbackUrl);
  };

  hls.on(Hls.Events.MEDIA_ATTACHED, load);
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (destroyed) return;
    manifestRetries = 0;
    void startMuted(video, onAudioBlocked, onAutoplayRefused);
  });
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    if (!destroyed) onPhaseChange('playing');
  });

  hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
    if (destroyed || !data.fatal) return;

    /**
     * A missing manifest is the creator not being on air YET.
     *
     * This is the single most common thing that goes "wrong" on this screen
     * and it is not a failure: the row says the session is live from the
     * moment the egress starts, and Bunny needs a few seconds of RTMP before
     * it writes a playlist. Reported as 'waiting', retried, and only escalated
     * to an error once the budget above is spent.
     */
    const isManifestMissing =
      data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
      data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
      data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;

    /**
     * A 403 is not "not started yet" and must never be retried as one.
     *
     * 404 means Bunny has no playlist because no frames have arrived — the
     * normal state of a viewer who is early, and worth waiting through. 403
     * means the CDN is REFUSING this viewer: a token that does not match, an
     * expired `expires`, or a pull-zone rule (hotlink protection, geo, IP
     * blocking). Retrying that for two minutes and then saying "the creator
     * has not started" would be a lie, and it is the specific confusion that
     * cost an afternoon of debugging on 2026-09-01.
     */
    const httpStatus = data.response?.code;
    if (isManifestMissing && httpStatus === 403) {
      console.error('[live/hls] CDN refused the playlist (403)', data.response);
      onPhaseChange('error', 'cdn_refused');
      onError('ไม่มีสิทธิ์เข้าถึงสตรีม กรุณาโหลดหน้านี้ใหม่');
      return;
    }

    if (isManifestMissing && manifestRetries < MANIFEST_RETRY_LIMIT) {
      manifestRetries += 1;
      onPhaseChange('waiting', 'manifest_missing');
      retryTimer = setTimeout(load, MANIFEST_RETRY_DELAY_MS);
      return;
    }

    /**
     * The budget is spent and there is still no playlist.
     *
     * Said plainly rather than left on a spinner: two minutes of RTMP with no
     * playlist at the end of it is not a slow creator, it is a stream that is
     * not being produced, and the viewer should be told so instead of being
     * asked to keep waiting.
     */
    if (isManifestMissing) {
      console.error('[live/hls] no playlist after the full retry budget', data.details, data.response);
      onPhaseChange('error', 'manifest_missing');
      onError('ไลฟ์นี้ยังไม่ส่งสัญญาณ กรุณาลองใหม่อีกครั้งภายหลัง');
      return;
    }

    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        // startLoad() resumes from the live edge rather than replaying, which
        // is what a viewer of a live stream wants after a dropout.
        hls.startLoad();
        onPhaseChange('waiting', 'network');
        return;
      case Hls.ErrorTypes.MEDIA_ERROR:
        hls.recoverMediaError();
        onPhaseChange('waiting', 'media');
        return;
      default:
        onPhaseChange('error', 'unknown');
        onError('การเล่นไลฟ์ขัดข้อง กรุณาโหลดหน้านี้ใหม่');
    }
  });

  hls.attachMedia(video);

  return {
    unmute: async () => {
      video.muted = false;
      try {
        await video.play();
        onAudioBlocked(false);
        onAutoplayRefused?.(false);
        return true;
      } catch {
        video.muted = true;
        return false;
      }
    },
    // hls.js exposes the live edge directly, which is more reliable than
    // reading video.seekable on a playlist that is still growing.
    seekToLive: () => {
      if (hls.liveSyncPosition !== null) video.currentTime = hls.liveSyncPosition;
    },
    destroy: () => {
      destroyed = true;
      if (retryTimer) clearTimeout(retryTimer);
      hls.destroy();
    },
  };
}
