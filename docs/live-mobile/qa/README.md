# Mobile viewer layout — QA captures

`/live/[sessionId]` below 768px, the full-bleed "Design C" layout.

Taken from `/dev/live-mobile` (the bench that mounts the real component tree
against a fabricated page state — see its header for why), in Chromium at
device scale 2, with an iPhone 14 Pro's safe-area insets emulated (59px top,
34px bottom). Two viewports:

| file | what it shows |
| --- | --- |
| `*-01-idle.jpg` | the resting screen: top bar, status pill, reaction rail, five chat lines, composer |
| `*-02-gifts.jpg` | a fullscreen Nova playing above a Stardust tray row, both clear of the chat column and of the creator's half of the frame |
| `*-03-chat-expanded.jpg` | the chat tapped open into scrollable history, with the "ย่อ" chip |
| `*-04-composing.jpg` | text in the composer, with the inline send button; the chat collapsed again by tapping the video |
| `*-05-ended.jpg` | the session over: layout and top bar kept, rail and composer gone, "ไลฟ์จบแล้ว" centred |

## What these captures cannot show

- **The video.** The bench has no broadcast, so the player renders its real
  "กำลังรอสัญญาณจาก Creator" state over a black frame. Everything a viewer
  touches sits above it; the gift stage sits below it and is dimmed by it.
- **The keyboard.** `visualViewport` reports one only when a real keyboard
  opens. The composer's rise above it (`useKeyboardInset`) needs a device, and
  is the first thing to check on an iPhone.

## Still outstanding — real devices

QA gates 1, 2 and 9 (Lighthouse) from the brief have not been run:

1. iPhone Safari and Android Chrome, portrait, under the notch and the home
   indicator.
2. Keyboard open on iOS: the composer above it, no jump on close.
9. Lighthouse mobile LCP against `main`.
