'use client';

/**
 * Where a gift is drawn on a phone — the ONE copy, for the viewer screen and
 * the creator's own.
 *
 * This was LiveViewerMobile's `giftAnchor`. It moved here when the host layout
 * was built, because "the creator sees what their audience sees, frame for
 * frame" is the rule GiftOverlay's header states, and two screens computing a
 * position from two copies of the same six constants is exactly how that stops
 * being true. Both screens now hand the same numbers to the same overlay.
 *
 * TWO RULES, AND NO RESERVED SLOT.
 *
 * With no tray row on screen the stage's bottom edge sits 12px above the chat
 * column's top. With one it sits 16px above the TRAY's top instead, which is
 * measured rather than assumed because a tray is one, two or three rows tall
 * depending on what has just been sent. The single constant this replaced held
 * the stage at the taller of the two at all times, so the common case — an
 * empty tray — put a gift across the middle of the broadcast.
 *
 * The stage then SHRINKS to fit under the 45% ceiling. Moving it down instead
 * would put it back over the chat, and the ceiling is the rule that keeps the
 * creator's face clear.
 */

import { useMemo, useState } from 'react';
import { useTopFromViewportBottom, type GiftAnchor } from '../gifts/useStageScale';
import { useViewportSize } from './useMobileViewport';

/**
 * Where the TRAY sits, measured up from the bottom of the SCREEN.
 *
 * The design's 238px from the bottom of a 375 x 812 iPhone: 192 here, plus the
 * 12px of overlay inset the tray adds as padding under itself, plus that
 * phone's 34px indicator. A clearance on top of the safe-area inset rather than
 * an absolute coordinate, so an Android phone with no home indicator gets the
 * same gap above the composer as an iPhone with one.
 */
export const GIFT_TRAY_BOTTOM = 'calc(var(--live-safe-bottom, 0px) + 192px)';

/** The design's stage size: `min(52vw, 200px)`, as a number (see useStageScale). */
const GIFT_STAGE_MAX_PX = 200;
const GIFT_STAGE_VW = 0.52;
/** Floor, so a squeezed stage is still a gift rather than a smudge. */
const GIFT_STAGE_MIN_PX = 96;

/** The stage's bottom edge clears the chat column's top by this much. */
const GIFT_STAGE_OVER_CHAT_PX = 12;
/** ...and the tray's top by this much, whenever a row is on screen. */
const GIFT_STAGE_OVER_TRAY_PX = 16;

/**
 * The stage's top may never be above this fraction of the viewport.
 *
 * The centre of the frame is the creator's face; the reaction rail already
 * states the same rule for itself. Enforced by SHRINKING the stage rather than
 * by moving it down, because moving it down would put it back over the chat.
 */
const GIFT_STAGE_TOP_LIMIT = 0.45;

/**
 * Room reserved under the stage for the caption, in px.
 *
 * The caption is laid out by flow, not by this number — it exists only so the
 * ceiling is applied to the whole block (stage + gap + caption) rather than to
 * the stage alone. Three lines of the phone caption measure 65px on a 375px
 * screen; 68 leaves a little over, and `maxHeightPx` is what makes the rule
 * hold anyway when a message wraps further than that.
 */
const GIFT_CAPTION_HEADROOM_PX = 68;

/**
 * What the chat column's top is assumed to be for the one frame before it has
 * been measured: composer, gap, five lines and the page inset on an iPhone.
 */
const CHAT_TOP_FALLBACK_PX = 238;

/**
 * @param bottomStackNode the chat column and composer together; its top edge is
 *   "the chat column top" the stage has to sit above.
 * @param trayTop where the tray's top edge is, measured up from the bottom of
 *   the viewport, and 0 when no row is rendered. GiftOverlay reports it through
 *   `onTrayTopChange`.
 */
export function useMobileGiftAnchor(
  bottomStackNode: HTMLElement | null,
  trayTop: number,
): GiftAnchor {
  const { width: viewportWidth, height: viewportHeight } = useViewportSize();
  const chatTop = useTopFromViewportBottom(bottomStackNode);

  return useMemo<GiftAnchor>(() => {
    const bottomPx =
      trayTop > 0
        ? trayTop + GIFT_STAGE_OVER_TRAY_PX
        : (chatTop || CHAT_TOP_FALLBACK_PX) + GIFT_STAGE_OVER_CHAT_PX;

    // The ceiling, expressed the same way everything else here is: as a
    // distance UP from the bottom of the viewport — so `blockRoomPx` is how
    // tall the whole block may be before its top crosses the 45% line.
    const ceilingPx = (viewportHeight || 0) * (1 - GIFT_STAGE_TOP_LIMIT);
    const blockRoomPx = ceilingPx - bottomPx;

    const designPx = Math.min(
      GIFT_STAGE_MAX_PX,
      (viewportWidth || GIFT_STAGE_MAX_PX * 2) * GIFT_STAGE_VW,
    );
    const stagePx = Math.max(
      GIFT_STAGE_MIN_PX,
      viewportHeight > 0
        ? Math.min(designPx, blockRoomPx - GIFT_CAPTION_HEADROOM_PX)
        : designPx,
    );

    /*
      THE ONE CASE WHERE THE TWO RULES CANNOT BOTH HOLD, stated rather than
      hidden. A tray row is ~143px tall and the chat column's top is ~240px up
      on a 375 x 812 phone, so "16px above the tray" puts the stage's bottom
      edge at ~385px — and the 45% line is at ~447px. That leaves ~47px for a
      stage and its caption, which is less than the floor, and a gift squeezed
      into it would be a smudge nobody can identify.

      So the ceiling is enforced only where it is satisfiable — which is the
      common case, an empty tray — and with a row on screen the stage keeps its
      floor and clears it, for the four and a half seconds that row lives.
    */
    const ceilingIsMeetable =
      viewportHeight > 0 && blockRoomPx >= GIFT_STAGE_MIN_PX + GIFT_CAPTION_HEADROOM_PX;

    return {
      left: '14px',
      bottom: `${Math.round(bottomPx)}px`,
      stagePx,
      // A video card is 1.5x as wide as it is tall; without this it would be
      // drawn past the chat column it is supposed to sit above.
      maxWidthPx: stagePx,
      maxHeightPx: ceilingIsMeetable ? Math.floor(blockRoomPx) : undefined,
      trayBottom: GIFT_TRAY_BOTTOM,
      // The stage is ABOVE the tray here, not in its corner, so there is
      // nothing for the tray to step aside from.
      trayShift: false,
    };
  }, [chatTop, trayTop, viewportWidth, viewportHeight]);
}

/**
 * The two pieces of state the anchor needs, and the handler GiftOverlay wants.
 *
 * Bundled so a screen wires the overlay up in three lines rather than six, and
 * so the viewer and the host cannot wire it up differently.
 */
export function useMobileGiftGeometry() {
  const [bottomStackNode, setBottomStackNode] = useState<HTMLDivElement | null>(null);
  const [trayTop, setTrayTop] = useState(0);
  const anchor = useMobileGiftAnchor(bottomStackNode, trayTop);
  return { anchor, setBottomStackNode, onTrayTopChange: setTrayTop };
}
