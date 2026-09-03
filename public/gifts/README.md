# น้อง Aurum gift mascots

Layer art for the live gift overlay (`components/live/gifts/animations/`).

## Everything in here is a PLACEHOLDER

The brief for this feature listed four reference animations under
`docs/gift-cards/` and a set of mascot PNGs under `public/gifts/`, to be
committed before the work started. Neither exists in this repository, on this
branch or in its history — so these files were generated to stand in for them,
and the four tier animations were authored from the written descriptions rather
than ported from the reference HTML.

They are deliberately simple: a rounded star with a face and a glowing antenna,
tinted per rarity. They are the right size, in the right places, split into the
right layers, so **replacing them is a file copy and nothing else** — no code
change, no rebuild of the animation components.

## The contract the code depends on

| Path | Used by | Notes |
|---|---|---|
| `tier-01/body.png` | `Tier01Stardust` | |
| `tier-01/arm.png` | `Tier01Stardust` | Waves. Rotated about its own **right edge**, so the shoulder must sit at the right of the image. |
| `tier-02/body.png` | `Tier02Moonlight` | |
| `tier-02/eyelid.png` | `Tier02Moonlight` | Blinks. Scaled on Y about its **top edge**; must cover the body's eyes at scale 1. |
| `tier-03/body.png` | `Tier03Comet` | |
| `tier-03/tail.png` | `Tier03Comet` | Streaks. Points **left**, with the hot end at the right where the mascot sits. |
| `tier-04/body.png` | `Tier04Nova` | |
| `tier-05/body.png` | `TierGenericFloat` | Tier is `TBD` until the CEO names it. |
| `tier-06/body.png` | `TierGenericFloat` | |
| `tier-07/body.png` | `TierGenericFloat` | |

- **300 × 300 px, PNG with alpha.** The stage is a 300 × 300 box and every
  layer is drawn at `inset: 0`, so a layer's position comes from its own
  transparent padding rather than from CSS offsets. Art at a different size
  will still render, scaled to the box — but the layers will no longer line up
  with each other.
- **The mascot occupies roughly the centre 220 px.** The margin is not waste:
  the glow, the antenna and the tier-01 arm swing into it.
- Keep files small. Each one is fetched during a broadcast, on a phone, while a
  video is playing — these placeholders are 13–16 KB and that is the right
  order of magnitude.

## What is missing, for whoever picks this up

Tiers 05–07 have no name, no subtitle and no animation of their own. They are
seeded as `TBD` in `gift_tiers` and all three render `TierGenericFloat`.
Naming them is an `UPDATE` on that table; giving one its own animation means
adding a component and one line in `animations/index.ts` — the DB's
`animation_key` is what selects it, so nothing else has to change.
