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
| `05.jpg` | tier-05 | 7.0s of 14.9 |
| `06.jpg` | tier-06 | 9.5s of 19.9 |
| `07.jpg` | tier-07 | 21.0s of 42.2 |
| `gate-375px.jpg` | — | 375px: no horizontal overflow, sender name un-truncated |
| `gate-reduced-motion.jpg` | Nova | `prefers-reduced-motion: reduce` — hero on Earth, nothing running |

Re-capturing these is a scripted pass over `/dev/gifts` with the
"บังคับเต็มจอทุกชั้น" toggle on; nothing here is hand-composed.
