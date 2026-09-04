# น้อง Aurum gift art

The layer art behind the live gift overlay (`components/live/gifts/animations/`).

Everything here is the real art, delivered by the CEO and committed unchanged.
The four `.html` gift cards it was cut from live in `docs/gift-cards/` — those
are the **authority** for the animations: the components in `animations/` are a
1:1 port of their keyframes, so a change to a timing here should start there.

## The contract the components depend on

Every stage is a 300 × 300 box and every full-frame layer is drawn at
`inset: 0` with `object-fit: contain`, so a layer's position on screen comes
from its own transparent padding, not from CSS offsets. The art is authored at
640 × 640 (the tier-03 tail at the original 1024 frame's proportions) and
scales into that box; swapping in a file with different padding moves the
mascot without any code changing.

| Path | Component | What the code assumes about it |
|---|---|---|
| `tier-01/body.png` | `Tier01Stardust` | Full frame. Rises from below the stage. |
| `tier-01/arm.png` | `Tier01Stardust` | Full frame, aligned to the body. Waves — rotated about the shoulder at `68.4% 63.8%` of the stage. |
| `tier-02/body.png` | `Tier02Moonlight` | Full frame. Pirouettes in 3D. |
| `tier-02/eyelid.png` | `Tier02Moonlight` | A 27 × 27 skin patch, drawn centred on the right eye at `59.8% 41.5%`. Toggled opaque for the wink — it does not scale. |
| `tier-03/body.png` | `Tier03Comet` | Drawn at `109.3px, 23.4px` sized `210.4px`, which is where the body sits inside the tail's original 1024 frame. |
| `tier-03/tail.png` | `Tier03Comet` | Full frame: the comet **with** the mascot in it. Fades out on landing, leaving `body.png` standing. |
| `tier-04/body.png` | `Tier04Nova` | Drawn 150 × 150 at `75px, 81px` — standing on the CSS Earth. |
| `tier-05/`, `tier-06/`, `tier-07/` | `TierVideoClip` | `clip.mp4` + `clip.webm` + `poster.jpg`. No PNG: these tiers are rendered video, not CSS. |

## Weight

The PNGs are 14 KB–340 KB and are already optimally compressed (re-encoding
them at maximum PNG effort makes them *larger*). They are fetched once per
device and cached; the video clips are the ones with a real cost, and their
budget is documented in `docs/live-gifts.md`.
