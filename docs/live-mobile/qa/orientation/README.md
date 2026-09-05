# Phone viewer — both orientations

From `/dev/live-mobile`, with iPhone safe areas emulated for the orientation
being shown: 59/34 top and bottom upright, 0/21 and 47 down each side on its
side, which is where the notch actually goes.

| file | what it shows |
| --- | --- |
| `portrait-375x812-01-idle.jpg` | resting: two-row top bar, seven-button rail, five chat lines, composer |
| `portrait-375x812-02-nova-no-tray.jpg` | tray empty — the stage sits 12px above the chat, its top on the 42% line |
| `portrait-375x812-03-nova-with-tray.jpg` | a Stardust row lands, the stage lifts clear of it, and drops back within 220ms of the row expiring |
| `portrait-375x812-04-tier07-with-tray.jpg` | the tier-07 clip in the same arrangement — the width cap keeps it in the stage's column |
| `landscape-812x375-*` | the same four, with the layout on its side |

## What the landscape variant changes

One-row top bar (capsule, LIVE pill, viewer count, ✕), a compact six-button
rail, a 300px three-line chat column, and the gift tray parked beside the stage
instead of above it — 375px of height cannot hold a stage above a 117px tray
row above three lines of chat above a composer. Everything else is the same
elements with different numbers, which is what lets a rotation be a re-render
rather than a remount.

## Verified in the browser, not by eye

- `object-fit` defaults to cover, the rail's ⛶ toggles it to contain, and the
  choice survives a reload (`aurum:viewer:fit`).
- Rotating the viewport keeps the SAME `<video>` node and the same layout root
  — asserted by tagging the element and re-reading it after the resize — so the
  stream is not restarted and the Realtime channel above it never notices.

## Still outstanding — real devices

- iOS: safe areas, the keyboard riding the composer up, and the ⤢ button's
  fallback (no Fullscreen API there, so it raises the "rotate your device"
  toast instead).
- Android: ⤢ entering fullscreen and locking to landscape, then restoring.
- The upward crop bias on a LANDSCAPE source (`object-position: 50% 30%`). The
  bench has no stream, so this path is reasoned, not observed — it needs a
  16:9 broadcast on a phone.
- Lighthouse mobile LCP against `main`.
