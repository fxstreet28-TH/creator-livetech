"use client";

/**
 * The origin path's player: WHEP first, HLS when WHEP cannot deliver.
 *
 * WHY A COMPONENT AND NOT A TERNARY IN THE PAGE. The choice between the two
 * players is not made once at mount — it is made again the moment WHEP gives
 * way, which can be eight seconds in, and again on the resume after that — so
 * it is a small state machine, and there are two viewer layouts that need
 * exactly the same one (LiveWatchView on desktop, LiveViewerMobile on the
 * phone). Written inline it would be two copies, and the day they drifted is
 * the day one of them stopped falling back.
 *
 * A DROP-IN FOR HlsLivePlayer, deliberately. It takes that component's props
 * unchanged and passes them through untouched, so a call site swaps the name
 * and nothing else. That is also why it accepts `source: 'llhls'` rather than
 * refusing it: Bunny Live sessions never had a WHEP endpoint, and a router that
 * had to be guarded by its callers would have put the same `source === 'origin'`
 * test back in both layouts.
 *
 * THE SWAP USED TO BE ONE-WAY AND PERMANENT FOR THE MOUNT. It no longer is, and
 * that is the point of PR #67.
 *
 * PR #60's rule was "WHEP is never retried — one failure falls back to HLS
 * permanently for this mount", on the reasoning that a WebRTC handshake which
 * just failed fails again for the same reason. That reasoning holds for the
 * failures it was written against: WebRTC switched off, UDP eaten by a
 * corporate firewall, an origin that is unwell. It does not hold for the
 * failure that turned out to dominate real usage. iOS Safari closes active peer
 * connections when the page goes to the background — so a viewer who folded
 * their phone for ten seconds triggered the permanent rule, and gave up the
 * low-latency path for the remaining fifty minutes of the broadcast over an
 * ordinary phone gesture. A dead connection after a suspension is not evidence
 * about WHEP; it is evidence that the tab was suspended.
 *
 * So the rule is split in two:
 *
 *  STRUCTURAL failures still retire WHEP for the whole mount, exactly as
 *  before — no RTCPeerConnection, 404/405/501 from the endpoint, a browser that
 *  will not build an offer. See isStructuralWhepFailure, which is where the
 *  list lives and is explained.
 *
 *  EVERYTHING ELSE retires it only for THIS CYCLE. The viewer goes to HLS
 *  immediately, keeps PR #52's ladder behind them, and the next resume after a
 *  short cooldown puts them back on WHEP-first. A viewer who folds their phone
 *  five times in an hour gets sub-second latency five times, instead of once.
 *
 * WHAT THE VIEWER GETS OUT OF IT. WHEP is MediaMTX sending RTP straight to the
 * browser: 200-500ms, LiveKit's number, with no Bunny egress billed at all.
 * HLS through the CDN is 5-7 seconds and cannot be tuned below that (PR #59).
 * So this is the same session, the same server and the same cost model, played
 * an order of magnitude closer to live whenever the network allows it — and now
 * re-asked whenever the network might have started allowing it again.
 */

import { useCallback, useRef, useState } from "react";
import { HlsLivePlayer, type HlsLivePlayerProps } from "./HlsLivePlayer";
import { WhepLivePlayer } from "./WhepLivePlayer";
import { useResumeTriggers } from "@/lib/live/useResumeTriggers";
import {
  isStructuralWhepFailure,
  whepEndpointFromHlsPlaybackUrl,
} from "@/lib/live/whepClient";

/**
 * How long after falling back to HLS before a resume may try WHEP again.
 *
 * THE GUARD AGAINST A FLAPPING VIEWER. Without it, someone on a network that
 * genuinely cannot carry WebRTC would pay three failed handshakes and a fresh
 * HLS player every time they glanced at a notification — which is worse for
 * them than never trying WHEP at all, because each cycle costs them the picture
 * they already had.
 *
 * Thirty seconds is long enough that a viewer flicking between apps does not
 * re-enter, and short enough that the wifi-came-back case (Por's test 3) gets
 * its low-latency path back inside one ordinary distraction.
 */
const WHEP_RETRY_COOLDOWN_MS = 30_000;

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
   * Which player is mounted, and whether WHEP may ever come back.
   *
   * `retired` is the old `whepFailed`, kept for structural failures only: set
   * once, never cleared, and not keyed on `playbackUrl` — useLiveWatch re-mints
   * that URL on a timer, and a flag that reset with it would put a viewer whose
   * browser has no WebRTC back through a doomed handshake every hour.
   *
   * `onHls` is the cycle-scoped half. It is what a retryable failure sets, and
   * what a resume after the cooldown clears.
   */
  const [retired, setRetired] = useState(false);
  const [onHls, setOnHls] = useState(false);
  /**
   * Bumped on every return to WHEP.
   *
   * It is the WhepLivePlayer's `key`, so coming back means a genuinely fresh
   * component with a fresh handshake and a fresh retry budget — not a remount
   * of one that is still holding the state that made it fall back.
   */
  const [whepAttempt, setWhepAttempt] = useState(0);
  const fellBackAtRef = useRef(0);

  const handleWhepFailure = useCallback((reason: string) => {
    const structural = isStructuralWhepFailure(reason);
    fellBackAtRef.current = Date.now();
    console.info("[whep] switching to HLS playback", {
      reason,
      structural,
      retry_on_resume: !structural,
    });
    if (structural) setRetired(true);
    setOnHls(true);
  }, []);

  /**
   * The way back to WHEP.
   *
   * Deliberately NOT conditional on the HLS player being unhealthy. A viewer
   * sitting on a perfectly good HLS stream is still five to seven seconds
   * behind the live edge, and the whole of the origin path exists to not do
   * that to them; the fallback was a compromise forced by a suspension that has
   * since ended. The cost of being wrong is one handshake and, at worst, a
   * return to the player they are already watching.
   */
  useResumeTriggers({
    enabled: !!whepUrl && onHls && !retired && hlsProps.recoveryEnabled !== false,
    onResume: useCallback(
      (event) => {
        const sinceFallbackMs = Date.now() - fellBackAtRef.current;
        if (sinceFallbackMs < WHEP_RETRY_COOLDOWN_MS) {
          console.info("[whep] resume inside the cooldown; staying on HLS", {
            trigger: event.trigger,
            since_fallback_ms: sinceFallbackMs,
          });
          return;
        }
        console.info("[whep] resume after cooldown; trying WHEP again", {
          trigger: event.trigger,
          since_fallback_ms: sinceFallbackMs,
        });
        setWhepAttempt((n) => n + 1);
        setOnHls(false);
      },
      [],
    ),
  });

  if (whepUrl && !retired && !onHls) {
    return (
      <WhepLivePlayer
        key={whepAttempt}
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
