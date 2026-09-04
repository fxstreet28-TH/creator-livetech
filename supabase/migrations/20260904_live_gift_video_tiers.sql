-- =============================================================================
-- live_gift_video_tiers — tiers 05-07 become rendered clips
-- =============================================================================
--
-- Tiers 05, 06 and 07 have no CSS animation and never will: the CEO delivered
-- them as rendered video. They keep everything else about being a tier — a row,
-- a price the CRM can set, a rarity, a display mode — and differ only in that
-- `animation_key` now says 'video', which the overlay resolves to a component
-- that plays `/gifts/tier-0N/clip.mp4` instead of a stage full of CSS layers.
--
-- Nothing about the send path changes. `send_live_gift` reads `duration_ms` off
-- the row and broadcasts it, exactly as before.
--
-- WHY THE CHECK MOVES
--
-- `duration_ms` is meant to be how long the gift is actually on screen, and for
-- these three that is the length of the clip: 14.9s, 19.9s and 42.2s. The
-- original CHECK topped out at 30000, which was a guess made before any clip
-- existed — tier 07 does not fit under it. Raising it to 45000 keeps the column
-- doing its job rather than making the longest gift on the board lie about how
-- long it holds the screen.
--
-- 45s IS A CEILING, NOT AN ENDORSEMENT. A fullscreen gift blocks every other
-- fullscreen gift behind it for its full duration, and covers the creator's
-- video the whole time. Forty-two seconds of that is a long time to take a
-- broadcast away from the person running it, and a shorter cut of tier 07 would
-- very likely play better; the number here is what the delivered clip measures,
-- and shortening it is a product decision, not this migration's.
--
-- The client's own clamp in `lib/live/gifts.ts` mirrors this CHECK. If this
-- number moves again, move that one too.
-- =============================================================================

BEGIN;

ALTER TABLE public.gift_tiers
  DROP CONSTRAINT IF EXISTS gift_tiers_duration_ms_check;

ALTER TABLE public.gift_tiers
  ADD CONSTRAINT gift_tiers_duration_ms_check
  CHECK (duration_ms BETWEEN 1000 AND 45000);

-- Durations are the measured length of each encoded clip, rounded to the
-- millisecond: ffprobe reports 14.933333s, 19.900000s and 42.233333s.
UPDATE public.gift_tiers
   SET animation_key = 'video',
       duration_ms   = 14933,
       updated_at    = now()
 WHERE id = 5;

UPDATE public.gift_tiers
   SET animation_key = 'video',
       duration_ms   = 19900,
       updated_at    = now()
 WHERE id = 6;

UPDATE public.gift_tiers
   SET animation_key = 'video',
       duration_ms   = 42233,
       updated_at    = now()
 WHERE id = 7;

COMMIT;
