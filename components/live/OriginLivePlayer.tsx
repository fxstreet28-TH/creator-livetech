"use client";

/**
 * The origin path's player: WHEP first, HLS for the rest of the session.
 *
 * WHY A COMPONENT AND NOT A TERNARY IN THE PAGE. The choice between the two
 * players is not made once at mount — it is made again the moment WHEP gives
 * way, which can be eight seconds in — so it is a small state machine, and
 * there are two viewer layouts that need exactly the same one (LiveWatchView on
 * desktop, LiveViewerMobile on the phone). Written inline it would be two
 * copies, and the day they drifted is the day one of them stopped falling back.
 *
 * A DROP-IN FOR HlsLivePlayer, deliberately. It takes that component's props
 * unchanged and passes them through untouched, so a call site swaps the name
 * and nothing else. That is also why it accepts `source: 'llhls'` rather than
 * refusing it: Bunny Live sessions never had a WHEP endpoint, and a router that
 * had to be guarded by its callers would have put the same `source === 'origin'`
 * test back in both layouts.
 *
 * THE SWAP IS ONE-WAY AND PERMANENT FOR THE MOUNT. WHEP is not retried after it
 * fails, and that is a decision rather than an omission: a WebRTC handshake that
 * just failed fails again for the same reason — WebRTC disabled, UDP eaten by a
 * corporate firewall, an origin that is unwell — and each retry is more seconds
 * of black screen bought with the viewer's patience. PR #52's ladder takes over
 * from here, on the HLS player, which is exactly where it should be running.
 *
 * WHAT THE VIEWER GETS OUT OF IT. WHEP is MediaMTX sending RTP straight to the
 * browser: 200-500ms, LiveKit's number, with no Bunny egress billed at all.
 * HLS through the CDN is 5-7 seconds and cannot be tuned below that (PR #59).
 * So this is the same session, the same server and the same cost model, played
 * an order of magnitude closer to live whenever the network allows it.
 */

import { useCallback, useState } from "react";
import { HlsLivePlayer, type HlsLivePlayerProps } from "./HlsLivePlayer";
import { WhepLivePlayer } from "./WhepLivePlayer";
import { whepEndpointFromHlsPlaybackUrl } from "@/lib/live/whepClient";

/**
 * Exactly HlsLivePlayer's props, `onSourceOrientation` included — it is one of
 * them now, and both players take it. Nothing here to add: the letterbox rule
 * breaks silently, as a landscape source shown cropped, if the callback stops
 * firing on one of the two paths, so the router forwards it to both.
 */
export type OriginLivePlayerProps = HlsLivePlayerProps;

export function OriginLivePlayer(hlsProps: OriginLivePlayerProps) {
  /**
   * Resolved on every render rather than memoised: it is a URL parse against a
   * prop that does not change for the life of a broadcast (the origin playback
   * URL is stable — see live-get-playback-url, which mints no signature), and a
   * useMemo here would cost more to read than the parse costs to run.
   *
   * Null for anything that is not an origin playlist, which includes every
   * llhls session. That is the pass-through case, and it renders exactly what
   * the call site rendered before this component existed.
   */
  const whepUrl =
    hlsProps.source === "origin"
      ? whepEndpointFromHlsPlaybackUrl(hlsProps.playbackUrl)
      : null;

  /**
   * Set once, never cleared.
   *
   * Not keyed on `playbackUrl`, and that matters: useLiveWatch re-mints the
   * playback URL on a timer, and a fallback that reset with it would put a
   * viewer who has settled on HLS back through a doomed WHEP handshake every
   * hour, mid-broadcast.
   */
  const [whepFailed, setWhepFailed] = useState(false);

  const handleWhepFailure = useCallback((reason: string) => {
    console.info("[whep] switching this session to HLS playback", { reason });
    setWhepFailed(true);
  }, []);

  if (whepUrl && !whepFailed) {
    return (
      <WhepLivePlayer
        whepUrl={whepUrl}
        title={hlsProps.title}
        elapsedSeconds={hlsProps.elapsedSeconds}
        viewerCount={hlsProps.viewerCount}
        overlay={hlsProps.overlay}
        presentation={hlsProps.presentation}
        fit={hlsProps.fit}
        recoveryEnabled={hlsProps.recoveryEnabled}
        onFailure={handleWhepFailure}
        onSourceOrientation={hlsProps.onSourceOrientation}
      />
    );
  }

  // Untouched, whichever way we arrived here: the same props the call site
  // would have passed, and the same self-healing ladder behind them.
  return <HlsLivePlayer {...hlsProps} />;
}
