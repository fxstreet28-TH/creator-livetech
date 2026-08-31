'use client';

/**
 * Direct browser -> Bunny Stream upload, over TUS.
 *
 * Replaces the XMLHttpRequest PUT this module used to do. That flow was not
 * slow, it was unsafe: the PUT authenticated with `AccessKey`, and the value
 * the backend put in that header was the Bunny Stream *library* API key. Any
 * creator could read it out of the network panel and then list, download or
 * delete every video in the library, including other creators'. The TUS flow
 * authenticates with a per-video signature that the backend computes and that
 * expires — see TusUploadHeaders in ./types.
 *
 * Resumability comes with the protocol rather than being the reason for it:
 * tus-js-client re-negotiates the offset after a dropped connection and
 * continues from there, so a 2 GB upload on Thai mobile no longer restarts
 * from zero on every hiccup.
 */

import * as tus from 'tus-js-client';

/** Rejection reason for a cancel. Callers switch on this, not on message text. */
export const UPLOAD_ABORTED = 'UPLOAD_ABORTED';

/**
 * Backoff before each resume attempt, per the sprint brief. The leading 0
 * retries immediately once, which covers the single dropped packet that is
 * most of what a phone on 4G actually hits.
 */
export const TUS_RETRY_DELAYS_MS = [0, 3000, 5000, 10000, 20000];

/** How many resume attempts the creator is told about ("ลองใหม่ 2/5"). */
export const TUS_MAX_RETRIES = TUS_RETRY_DELAYS_MS.length;

/** Bunny's recommended TUS chunk size. */
const CHUNK_SIZE_BYTES = 50 * 1024 * 1024;

export interface UploadOptions {
  file: File;
  /** `tus_upload_endpoint` from the upload request. */
  endpoint: string;
  /** `tus_headers`, verbatim. SECURITY: a credential — never log this. */
  headers: Record<string, string>;
  /** `tus_metadata`, verbatim. */
  metadata: Record<string, string>;
  onProgress: (bytesUploaded: number, bytesTotal: number) => void;
  /** Called when a chunk failed and a resume is about to be scheduled. */
  onRetry?: (attempt: number, maxAttempts: number) => void;
  signal?: AbortSignal;
}

/**
 * True for a failure where resuming the same upload can still succeed.
 *
 * tus-js-client's own default retries any 5xx and any network-level failure.
 * This narrows it in one direction only: a 4xx from Bunny (401/403 on an
 * expired or wrong signature, 404 on a video that no longer exists) means the
 * credential this upload is holding will never be accepted, and five polite
 * retries against it only delay the honest failure. 409 and 423 stay
 * retryable — they are TUS's "offset conflict" and "file locked", both
 * transient.
 */
function isResumable(error: tus.DetailedError): boolean {
  const status = error.originalResponse?.getStatus() ?? 0;
  if (status >= 400 && status < 500) return status === 409 || status === 423;
  return true;
}

/**
 * Upload `file` to Bunny and resolve when Bunny has all of it.
 *
 * Rejects with UPLOAD_ABORTED when `signal` fires, and with the underlying
 * tus error otherwise — pass that to thaiForUploadError() for copy.
 */
export function uploadWithTus(opts: UploadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error(UPLOAD_ABORTED));
      return;
    }

    // onError can still fire after abort() tears the request down, and the
    // abort listener must not fire after a success. One latch for both.
    let settled = false;

    const upload = new tus.Upload(opts.file, {
      endpoint: opts.endpoint,
      headers: opts.headers,
      metadata: opts.metadata,
      chunkSize: CHUNK_SIZE_BYTES,
      retryDelays: TUS_RETRY_DELAYS_MS,
      /**
       * No localStorage (non-negotiable #8). tus-js-client otherwise writes
       * the upload URL there so an upload can be resumed after a page reload;
       * within one page the offset lives in memory and resume works without
       * it. A reload starts over, which is what the old PUT flow did anyway.
       */
      storeFingerprintForResuming: false,
      onShouldRetry: (error, retryAttempt) => {
        if (settled) return false;
        const retry = isResumable(error);
        // retryAttempt is 0-based and counts the attempt about to be made.
        if (retry) opts.onRetry?.(retryAttempt + 1, TUS_MAX_RETRIES);
        return retry;
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        if (!settled) opts.onProgress(bytesUploaded, bytesTotal);
      },
      onError: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
      onSuccess: () => {
        if (settled) return;
        settled = true;
        cleanup();
        // The last progress event can land a few kB short of the total; the
        // bar must not stop at 99% on a finished upload.
        opts.onProgress(opts.file.size, opts.file.size);
        resolve();
      },
    });

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // shouldTerminate stays false: the reserved Bunny video and the draft
      // feed_posts row are the backend's to clean up, and a DELETE from here
      // would need a credential this signature deliberately does not grant.
      void upload.abort();
      reject(new Error(UPLOAD_ABORTED));
    };

    function cleanup() {
      opts.signal?.removeEventListener('abort', onAbort);
    }

    opts.signal?.addEventListener('abort', onAbort, { once: true });
    upload.start();
  });
}

/**
 * Thai copy for an upload failure. Abort is the caller's to handle.
 *
 * The 4xx branch is the one that matters operationally: it is what a creator
 * sees when the hour-long signature expired mid-upload, and the fix is a
 * fresh `content-request-video-upload`, which is exactly what "ลองใหม่" on
 * the progress card does.
 */
export function thaiForUploadError(error: unknown): string {
  const response = (error as tus.DetailedError | undefined)?.originalResponse;
  const status = typeof response?.getStatus === 'function' ? response.getStatus() : 0;

  if (status === 401 || status === 403) {
    return 'สิทธิ์อัปโหลดหมดอายุ กรุณากดลองใหม่เพื่อเริ่มการอัปโหลดอีกครั้ง';
  }
  if (status >= 400 && status < 500) {
    return 'ระบบวิดีโอปฏิเสธไฟล์นี้ กรุณาลองใหม่อีกครั้ง';
  }
  if (status >= 500) {
    return 'ระบบวิดีโอไม่ตอบสนอง กรุณาลองใหม่อีกครั้ง';
  }
  return 'อัปโหลดไม่สำเร็จ การเชื่อมต่อขัดข้อง กรุณาลองใหม่';
}

export interface ProbedVideo {
  durationSeconds: number;
  width: number;
  height: number;
}

/**
 * Read duration and dimensions out of the file before uploading, using a
 * detached <video> element and an object URL.
 *
 * The duration decides `post_type` (short vs long) and is sent to
 * `check_creator_can_upload`, so a file we cannot probe is one we cannot
 * classify — the caller blocks the upload rather than guessing.
 */
export function probeVideoFile(file: File, timeoutMs = 15_000): Promise<ProbedVideo> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    // Muted + playsInline so iOS is willing to load metadata without a gesture.
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('PROBE_TIMEOUT'))),
      timeoutMs,
    );

    video.onloadedmetadata = () => {
      const duration = video.duration;
      // Infinity shows up for some WebM files with no duration in the header.
      if (!Number.isFinite(duration) || duration <= 0) {
        finish(() => reject(new Error('PROBE_NO_DURATION')));
        return;
      }
      const probed: ProbedVideo = {
        durationSeconds: duration,
        width: video.videoWidth,
        height: video.videoHeight,
      };
      finish(() => resolve(probed));
    };

    video.onerror = () => finish(() => reject(new Error('PROBE_FAILED')));
    video.src = url;
  });
}
