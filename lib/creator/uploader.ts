'use client';

/**
 * Direct browser -> Bunny Stream upload.
 *
 * XMLHttpRequest, not fetch: `upload.onprogress` is the only cross-browser way
 * to get byte-level progress on a request body, and it is the one thing this
 * module exists for. fetch() can stream a request in Chrome behind
 * `duplex: 'half'`, but not in Safari or in the Capacitor WKWebView, which is
 * where half our users will be.
 */

/** Rejection reasons. Callers switch on these, not on the message text. */
export const UPLOAD_ABORTED = 'UPLOAD_ABORTED';
export const UPLOAD_NETWORK = 'UPLOAD_NETWORK';
export const UPLOAD_REJECTED_PREFIX = 'UPLOAD_REJECTED_';

/** Backoff before retry 1 and retry 2. Network failures only. */
const RETRY_DELAYS_MS = [1000, 3000];

export interface UploadProgress {
  /** 0-100, integer. */
  percent: number;
  loaded: number;
  total: number;
}

/**
 * PUT the file to Bunny.
 *
 * `headers` goes on the request exactly as the backend returned it — including
 * its Content-Type, which is why none is added here. Bunny is strict about the
 * body being the raw file, and a browser-guessed multipart boundary would
 * corrupt the upload.
 *
 * Rejects with UPLOAD_ABORTED / UPLOAD_NETWORK / UPLOAD_REJECTED_<status>.
 */
export function uploadToBunny(
  file: File,
  uploadUrl: string,
  headers: Record<string, string>,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(UPLOAD_ABORTED));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);

    for (const [name, value] of Object.entries(headers)) {
      // setRequestHeader throws on a header the browser forbids scripts from
      // setting. Skipping one is better than failing the whole upload before
      // it starts; Bunny's AccessKey and Content-Type are both allowed.
      try {
        xhr.setRequestHeader(name, value);
      } catch {
        console.error('[uploader] browser refused header', name);
      }
    }

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total === 0) return;
      onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        // The last progress event can land a few kB short of total; the bar
        // must not stop at 99% on a finished upload.
        onProgress(100);
        resolve();
        return;
      }
      reject(new Error(`${UPLOAD_REJECTED_PREFIX}${xhr.status}`));
    };

    xhr.onerror = () => {
      cleanup();
      reject(new Error(UPLOAD_NETWORK));
    };

    xhr.ontimeout = () => {
      cleanup();
      reject(new Error(UPLOAD_NETWORK));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new Error(UPLOAD_ABORTED));
    };

    xhr.send(file);
  });
}

/** True for the failures where trying the same request again can succeed. */
export function isRetryableUploadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === UPLOAD_NETWORK) return true;
  // 5xx from Bunny's edge is worth one more go; 4xx is a permanent refusal
  // (bad key, video already uploaded, wrong library) and would fail the same
  // way every time.
  const status = Number(error.message.replace(UPLOAD_REJECTED_PREFIX, ''));
  return Number.isFinite(status) && status >= 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(UPLOAD_ABORTED));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error(UPLOAD_ABORTED));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * uploadToBunny with two automatic retries (1s, then 3s) on network failure.
 *
 * The same URL and headers are reused across attempts, which is correct for
 * this backend: `upload_url` is Bunny's own
 * `/library/{id}/videos/{guid}` endpoint authenticated by a header, not a
 * single-use signed link, so a retry overwrites the same reserved video. The
 * sprint brief assumed single-use URLs and therefore a re-request per retry —
 * doing that here would create a second Bunny video and a second draft
 * feed_posts row on every retry, and burn a slot of the creator's monthly
 * quota each time.
 *
 * A permanent failure (4xx) is not retried and comes straight back, so the
 * page can offer the user an explicit "ลองใหม่" that starts the whole flow —
 * including a fresh upload request — from the top.
 */
export async function uploadToBunnyWithRetry(
  file: File,
  uploadUrl: string,
  headers: Record<string, string>,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await uploadToBunny(file, uploadUrl, headers, onProgress, signal);
      return;
    } catch (err) {
      lastError = err;
      if (!isRetryableUploadError(err) || attempt === RETRY_DELAYS_MS.length) break;
      // Rewind the bar: the next attempt sends the whole file again, and a bar
      // that stays at 60% while nothing is moving is a lie.
      onProgress(0);
      await sleep(RETRY_DELAYS_MS[attempt], signal);
    }
  }

  throw lastError;
}

/** Thai copy for an upload rejection. Abort is the caller's to handle. */
export function thaiForUploadError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === UPLOAD_NETWORK) {
      return 'อัปโหลดไม่สำเร็จ การเชื่อมต่อขัดข้อง กรุณาลองใหม่';
    }
    if (error.message.startsWith(UPLOAD_REJECTED_PREFIX)) {
      return 'ระบบวิดีโอปฏิเสธไฟล์นี้ กรุณาลองใหม่อีกครั้ง';
    }
  }
  return 'อัปโหลดไม่สำเร็จ กรุณาลองใหม่';
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
