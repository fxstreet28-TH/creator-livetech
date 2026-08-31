'use client';

/**
 * The HLS player for /posts/[id].
 *
 * A bare <video src={hls}>, not an hls.js-backed player: hls.js is not a
 * dependency (package.json checked, per the "no new deps" rule), and pulling
 * one in is a Day 5-6 decision the brief explicitly defers — "native <video>
 * if hls.js is not already present". Safari, iOS and every Android WebView
 * play HLS natively; Chrome and Firefox on desktop do not, and are told so in
 * Thai rather than shown a silently dead player.
 *
 * Extracted here so the creator's own preview and the viewer's playback are
 * the same component — PostDetailView's inline player carried a
 * TODO(day-5) saying exactly that.
 *
 * `autoPlay` is off. A feed page that starts making noise the moment it loads
 * is hostile on mobile data, and iOS blocks unmuted autoplay anyway.
 */

import { useState } from 'react';
import { aspectClassFor } from '@/lib/viewer/publicFeed';

interface PublicVideoPlayerProps {
  /** HLS manifest URL from content-get-playback-url. */
  src: string;
  poster?: string | null;
  /** '16:9' | '9:16' | '1:1'. Defaults to 16:9 when unset. */
  aspectRatio?: string | null;
  /** Start playing on mount — used after an explicit tap on the poster. */
  autoPlay?: boolean;
  /** Accessible name, since a <video> has no intrinsic label. */
  title?: string | null;
}

export function PublicVideoPlayer({
  src,
  poster,
  aspectRatio,
  autoPlay = false,
  title,
}: PublicVideoPlayerProps) {
  /** Set when the <video> itself gives up — see the note below the player. */
  const [unsupported, setUnsupported] = useState(false);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
      <div className={`relative w-full ${aspectClassFor(aspectRatio)}`}>
        <video
          key={src}
          src={src}
          poster={poster ?? undefined}
          controls
          autoPlay={autoPlay}
          playsInline
          preload="metadata"
          aria-label={title?.trim() || 'วิดีโอ'}
          // Reported after the fact rather than predicted from canPlayType():
          // that probe needs `document`, which does not exist during the
          // prerender pass, so branching on it would render one tree on the
          // server and another on the client.
          onError={() => setUnsupported(true)}
          className="h-full w-full bg-black"
        />
      </div>

      {unsupported && (
        <p
          role="alert"
          className="border-t border-white/10 px-4 py-3 text-xs leading-relaxed text-white/50"
        >
          เบราว์เซอร์นี้ยังเล่นวิดีโอ HLS ไม่ได้ — ลองเปิดด้วย Safari หรือบนมือถือ
        </p>
      )}
    </div>
  );
}
