# §6 QA evidence

Mid-animation frames of all seven tiers, plus two of the gates, captured from
`/dev/gifts` in Chromium at the commit that introduced the real art.

The four CSS tiers are captured by **freezing the master timeline** at an exact
point — every animation on the page paused and its `currentTime` set — rather
than by waiting and hoping. Screenshot latency is tens of milliseconds and these
timelines have beats that last twenty, so "wait 2520ms then shoot" lands
somewhere else each run. The video tiers are seeked on the element itself.

| File | Tier | Frame |
|---|---|---|
| `01-stardust.jpg` | Stardust | 2,520ms of 4,500 — bubble up, sparks out |
| `02-moonlight.jpg` | Moonlight | 2,750ms of 5,500 — the wink |
| `03-comet.jpg` | Comet | 3,380ms of 6,500 — landed, shades on |
| `04-nova.jpg` | Nova | 4,000ms of 10,000 — beam firing at the meteor |
| `05.jpg` | tier-05 | 8.960s of 14.933 — the poster frame, watermark removed |
| `06.jpg` | tier-06 | 11.940s of 19.900 — the poster frame, watermark removed |
| `07.jpg` | tier-07 | 25.340s of 42.233 — the poster frame, watermark removed |
| `gate-375px.jpg` | — | 375px: no horizontal overflow, sender name un-truncated |
| `gate-reduced-motion.jpg` | Nova | `prefers-reduced-motion: reduce` — hero on Earth, nothing running |

Re-capturing these is a scripted pass over `/dev/gifts` with the
"บังคับเต็มจอทุกชั้น" toggle on; nothing here is hand-composed.

## Fullscreen layout (anchored desktop)

Captured with a fullscreen gift and a tray row on screen at the same time, so
the overlap check is a picture and not just an assertion. The clip is the player
box, not the window.

| File | Window | Case |
|---|---|---|
| `layout-1280-comet.jpg` | 1280 × 800 | Comet, 320px stage, tray parked at the far right |
| `layout-1280-nova.jpg` | 1280 × 800 | Nova, same block, longest caption |
| `layout-1280-tier07.jpg` | 1280 × 800 | tier-07 video card — 484 × 320, the widest thing the layout draws |
| `layout-1920-comet.jpg` | 1920 × 1080 | Comet, 413px stage, right edge at 33% |
| `layout-1920-nova.jpg` | 1920 × 1080 | Nova |
| `layout-1920-tier07.jpg` | 1920 × 1080 | tier-07 video card, 625 × 413 |
| `layout-375-comet.jpg` | 375 × 667 | unchanged — centred, dimmed backdrop, tray bottom-left |

Geometry is asserted rather than eyeballed: `giftLayout` is a pure function and
the browser pass reads back every box's rect, so "no overlap" and "6.1% left,
10.1% bottom" are measurements. `docs/live-gifts.md` §1e has the table.
