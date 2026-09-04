'use client';

/**
 * Tiers whose `animation_key` is 'video' — the ones the CEO delivered as
 * rendered clips rather than as CSS.
 *
 * ONE COMPONENT, SEVERAL TIERS
 *
 * Like TierGenericFloat, this is told which tier it is drawing and finds its
 * own files: `/gifts/tier-0N/clip.mp4` and `poster.jpg`. That is what lets an
 * eighth video tier be a row and two files in a folder — no component, no
 * deploy.
 *
 * WHY NO SOUND, NO CONTROLS AND NO LOOP
 *
 * `muted` + `playsInline` + `autoPlay` is the only combination every mobile
 * browser starts without a tap, and a gift that needed a tap would not be a
 * gift. It is also right on its own terms: this plays over a live broadcast,
 * and a clip with its own soundtrack would talk over the creator. Gift sound is
 * GiftSounds' business, and the viewer can mute it.
 *
 * `loop` is absent deliberately. The tier's `duration_ms` is the clip's
 * measured length, so the queue retires the gift as the last frame lands.
 *
 * WHY TWO ENCODES, MP4 FIRST
 *
 * H.264 is smaller and sharper per byte on this footage — measured, not
 * assumed: at 3.33 MB it scores SSIM 0.928 against the source where VP9 scores
 * 0.877 at 3.66 MB. So the MP4 is first and is what phones and desktop browsers
 * actually play.
 *
 * The WebM is not a size optimisation, it is a compatibility floor. H.264 is
 * patent-encumbered and open-source Chromium builds ship without a decoder for
 * it — `canPlayType('video/mp4; codecs="avc1…")` comes back empty and the
 * element errors with DEMUXER_ERROR_NO_SUPPORTED_STREAMS. That is not a
 * hypothetical: it is exactly what the Chromium this was tested in does, and
 * the OBS browser source a creator puts the overlay in is a Chromium embed
 * too. Without the VP9 fallback, the three most expensive gifts on the board
 * would silently degrade to a still image on the creator's own stream.
 *
 * Neither `<source>` carries a `codecs=` parameter. An over-specific type makes
 * a browser SKIP a file it could actually have played, and being wrong in that
 * direction costs more than the wasted probe.
 */

import { useState, type CSSProperties, type SyntheticEvent } from 'react';
import { stageStyle, type GiftAnimationProps } from './types';
import { useAnimationDone } from './useAnimationDone';
import styles from './TierVideoClip.module.css';

/**
 * Where a video tier's files live.
 *
 * Two digits, so tier 5 is `tier-05`: the folders are padded to sort correctly
 * in a directory listing, and the padding has to be reproduced here.
 */
function tierDir(tierId: number | undefined): string | null {
  if (!tierId || !Number.isInteger(tierId) || tierId < 1 || tierId > 99) return null;
  return `/gifts/tier-${String(tierId).padStart(2, '0')}`;
}

export function TierVideoClip({
  durationMs,
  onDone,
  reduceMotion = false,
  tierId,
  tint,
  className = '',
}: GiftAnimationProps) {
  useAnimationDone(durationMs, onDone);

  /**
   * Set if the clip cannot be fetched or decoded.
   *
   * A tier row can name a folder that is not deployed yet — the CEO adds the
   * row before the files land, or a CDN purge is in flight — and a renderer
   * could turn up that plays neither encode. The poster is already the bottom
   * layer, so failing over to it costs nothing and the gift still reads as a
   * gift rather than a black rectangle.
   */
  const [clipFailed, setClipFailed] = useState(false);

  /**
   * Only a failure of the ELEMENT counts, not of a `<source>`.
   *
   * React routes a child `<source>`'s error event to the parent's `onError`,
   * and the first source failing is the normal path here: a Chromium without
   * H.264 rejects the MP4 and then plays the WebM perfectly well. Taking that
   * as "the clip is broken" tears the video out mid-fallback and leaves the
   * still poster on screen — which is precisely the bug this fallback exists to
   * prevent. The media element's own error event is the one that means every
   * source has been exhausted, and it is the one whose target is the video.
   */
  const handleError = (event: SyntheticEvent<HTMLVideoElement>) => {
    if (event.target === event.currentTarget) setClipFailed(true);
  };

  const dir = tierDir(tierId);
  if (!dir) return null;

  return (
    <div
      aria-hidden
      className={`${styles.stage} ${reduceMotion ? styles.still : ''} ${className}`}
      style={stageStyle(durationMs, { '--tint': tint } as CSSProperties)}
    >
      <div className={styles.card}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${dir}/poster.jpg`} alt="" className={styles.poster} draggable={false} />
        {!reduceMotion && !clipFailed && (
          <video
            className={styles.clip}
            poster={`${dir}/poster.jpg`}
            autoPlay
            muted
            playsInline
            preload="auto"
            onError={handleError}
          >
            <source src={`${dir}/clip.mp4`} type="video/mp4" />
            <source src={`${dir}/clip.webm`} type="video/webm" />
          </video>
        )}
      </div>
    </div>
  );
}
