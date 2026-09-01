# Phase 2 — Live streaming: LiveKit-to-every-viewer → Bunny LL-HLS

Status: implemented, untested against a real broadcast.
Branch: `claude/phase2-llhls-migration-y9bljd`

---

## 1. The pre-flight finding that changed the design

The migration brief assumed the creator's browser could publish straight into
Bunny over WHIP. **It cannot.** Checked against library `740127` on 2026-09-01
by creating a live stream through the API and reading the response:

```json
"ingestEndpoints": { "rtmp": {
  "primaryIngestUrl": "rtmp://global.rtmp.mediadelivery.net/live",
  "backupIngestUrl":  "rtmp://global-backup.rtmp.mediadelivery.net/live"
}}
```

`rtmp` is the only key. `GET /whip/740127` is a 404, and the brief's two-step
`POST /videos` + `POST /videos/{id}/live` is not the API shape either — live
streams are a first-class resource at `/library/{id}/live`. Bunny's own
changelog puts live streaming in preview as of August 2026 with RTMP ingest.

A browser cannot open an RTMP connection: it needs a raw TCP socket. The
brief's fallback (WebCodecs → FFmpeg WASM) does not solve that — it still needs
a WebSocket→RTMP relay server, which Vercel cannot host.

**What shipped instead**, approved by CEO Por before any code was written:

```
creator browser --WebRTC--> LiveKit room --RoomComposite egress--> RTMP
  --> Bunny Live --transcode--> LL-HLS CDN --> every viewer (hls.js)
```

The creator still goes live from a browser tab with no OBS. The viewers — who
were the entire cost problem — leave the SFU. That keeps the saving, because
the saving was always in viewer bandwidth.

### What it costs

| | before | after |
|---|---|---|
| per stream-hour, flat | 0 | ~33 THB (1 publisher + 1 egress) |
| per viewer-hour | 2.26 THB | ~0.23 THB |
| 1h × 500 viewers | 1,130 THB | ~151 THB |
| effective per viewer-hour | 2.26 THB | **~0.30 THB** |

~7.6× cheaper against the 8.4× a pure-WHIP pipeline would have given. Break-even
moves to ~17 concurrent viewers (the brief projected 45), because the flat cost
replaced a per-viewer one.

---

## 2. Three things the brief assumed that were not true of this repo

Worth recording, because they were where most of the work went:

1. **Reactions and chat did not use Supabase Realtime.** They rode the LiveKit
   data channel. "No changes needed" would have deleted both features. They now
   travel on a private Realtime broadcast channel, `live:<session_id>`, gated by
   RLS policies on `realtime.messages` that use the same entitlement rule as the
   playback URL.
2. **Camera filters were preview-only.** They were a CSS `filter:` on the
   creator's own `<video>`; viewers always saw the raw camera, and the UI said
   so. They now go through a canvas that the publisher captures and publishes,
   so the look reaches the encoder, the egress, Bunny and the audience.
3. **There is no kill-switch banner.** `platform_status_public` and
   `platform_budget_state` exist, but nothing in the frontend reads them.
   Enforcement is server-side only: `check_creator_can_golive` refuses to start
   a broadcast, and `live-get-playback-url` turns viewers away at `emergency`.

---

## 3. What changed

### Database (`supabase/migrations/20260901_bunny_live_migration.sql`)

- `live_sessions`: `bunny_stream_id`, `bunny_ingest_url`, `bunny_stream_key`,
  `bunny_playback_url`, `bunny_thumbnail_url`, `livekit_egress_id`,
  `latency_mode`. The `livekit_*` columns stay — pre-migration rows must keep
  meaning what they meant.
- `platform_budget_state.bunny_live_cost_thb` — live delivery is now a third
  cost line, because LiveKit stopped scaling with the audience and Bunny started.
- `can_watch_live_session()` — one SECURITY DEFINER definition of who may watch,
  replacing three copies that were drifting apart.
- RLS policies on `realtime.messages` for `live:*` topics. This is what makes
  the chat channel private rather than joinable by anyone who can guess a UUID.
- `set_live_viewer_counts()` — raises the peak with `GREATEST` server-side.

### Edge Functions

| function | what it does now |
|---|---|
| `live-create-session` v3 | creates the Bunny live stream; new `start_egress` mode; `join` left untouched so production keeps working between the backend and frontend deploys |
| `live-end-session` v2 | **stops the egress** (nothing else will), splits the bill across two budget lines, deletes the Bunny stream only when nothing was recorded |
| `live-get-playback-url` v1 | login gate + entitlement + kill switch + a Bunny LL-HLS URL |
| `check-platform-budget` | reports `bunny_live_thb` alongside the other lines |

`supabase/functions/_shared/utils.ts` is now in the repo instead of existing
only in production.

### Frontend

- `hls.js` added. `livekit-client` stays — it is the publisher's SDK now.
- `lib/live/hlsPlayer.ts` — the only file that imports hls.js. Per-latency-mode
  tuning, manifest retry, autoplay handling, Safari native path.
- `lib/live/realtime.ts` + `lib/hooks/useLiveChannel.ts` — chat, reactions and
  the presence-based viewer count on one channel.
- `lib/live/cameraFilters.ts` — gains `createFilteredStream`, the canvas pipeline.
- `components/live/HlsLivePlayer.tsx` — new viewer.
- `components/live/LiveKitLivePlayer.tsx` — the old viewer, kept as the fallback.
- `CreatorBroadcaster`, `LiveChat`, `EmojiReactionButton`,
  `FloatingReactionsLayer`, `useLiveWatch` — rewired.
- The go-live form gains a latency control, so the documented "fall back to
  standard" is a creator's choice rather than a deploy.

---

## 4. Deliberate deviations from the brief

- **No `app/api/live/*` proxy routes.** The live screens already call Edge
  Functions through `supabase.functions.invoke`, which carries auth; a Next
  route in front would be indirection with no seam, and would not exist in the
  Capacitor build where there is no server.
- **The Bunny stream key is never returned to the browser.** The brief returned
  `ingest_url` and `stream_key` for browser WHIP. Under this pipeline only the
  egress speaks RTMP, server-side, so the page is not given a publish credential
  it has no use for.
- **`livekit-client` is not uninstalled.** Removing it would remove browser
  publishing. Phase 2B territory.
- **The viewer count comes from Realtime presence**, not from a counter
  incremented on playback-URL fetch. An HLS viewer closing a tab tells the
  server nothing, so a counter could only climb — and it would report a
  session's peak as its total arrivals, which is what the bill is computed from.

---

## 5. What is verified, and what is not

**Verified against live services:**

- Bunny Live create / read / delete on library `740127` (probe streams created
  and deleted; the library is back to zero).
- All four Edge Functions boot and run their code paths, including the vault
  reads for the Bunny secrets.
- LiveKit `ListEgress` → 200 with the `roomRecord` grant.
- LiveKit `StartRoomCompositeEgress` with this exact body →
  `{"code":"not_found","msg":"requested room does not exist"}`. That is the
  right failure: LiveKit parsed the whole request — `layout`, the `preset` enum
  by name, `streamOutputs` with `protocol: "RTMP"` — and got as far as the room
  lookup. A malformed body answers `malformed_request` instead.
- `npx tsc --noEmit`, `npm run lint` (no new problems), `npm run build`.

**Not verified — needs a real broadcast:**

- End-to-end video: camera → canvas → LiveKit → egress → Bunny → hls.js.
- Actual glass-to-glass latency against the <5s target.
- Whether Bunny's live playlist is genuinely LL-HLS (partial segments) or plain
  HLS. If plain, latency lands nearer 6s and `latency_mode` is the dial.
- Mobile Safari and mobile Chrome playback.
- A 60-minute session, including the playback-URL refresh at 50 minutes.
- Cost per viewer-hour against the ~0.30 THB projection.

---

## 6. Two things to decide before launch

1. **Bunny CDN token authentication is OFF.** There is no
   `bunny_stream_token_key` in the vault and the VOD path has always returned
   unsigned URLs. The login gate and entitlement check are enforced in
   `live-get-playback-url`, but the URL it returns is a plain CDN link that
   works for anyone it is pasted to until the stream ends. `signBunnyUrl` starts
   signing the moment that key exists, with no code change. Recommend turning
   token auth on for the pull zone and adding the key.
2. **Realtime presence at 500 viewers.** A presence sync sends the whole roster
   to every subscriber, so its cost grows with the square of the audience. It is
   comfortable in the low hundreds; the k6 load test is the place to measure it.
   If it is heavy, the fix is to stop tracking presence above a threshold and
   sample the count — not to go back to a counter that only ever climbs.

Also noted: `ingestRegion` came back `EU` and was not settable at create. The
ingest URL is anycast (`global.rtmp.mediadelivery.net`), so this may just be a
default label, but it is worth asking Bunny about for a Thai creator base.

---

## 7. Rollback

- **Whole feature:** revert the PR. The old Edge Functions still answer —
  `live-create-session mode=join` is untouched — so the previous frontend
  resumes working against them.
- **Delivery only:** a session whose Bunny create fails is written with
  `delivery: 'livekit'` and plays through `LiveKitLivePlayer` end to end. That
  path is exercised by the fallback and is not dead code.
- **Latency only:** set a session's `latency_mode` to `standard` from the
  go-live form.
- **Data:** `live_sessions` keeps both the `livekit_*` and `bunny_*` columns, so
  historical rows are readable whichever system produced them.
