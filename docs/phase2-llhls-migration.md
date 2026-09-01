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

**Since proven broken (see §5a):**

- End-to-end video. Every stage up to and including Bunny's ingest works;
  Bunny does not produce a playlist from it.

**Not verified — needs a real broadcast once §5a is resolved:**
- Actual glass-to-glass latency against the <5s target.
- Whether Bunny's live playlist is genuinely LL-HLS (partial segments) or plain
  HLS. If plain, latency lands nearer 6s and `latency_mode` is the dial.
- Mobile Safari and mobile Chrome playback.
- A 60-minute session, including the playback-URL refresh at 50 minutes.
- Cost per viewer-hour against the ~0.30 THB projection.

---

## 5a. BLOCKER: Bunny accepts the RTMP feed but never produces a playlist

Found 2026-09-01 after three live tests where the viewer sat on
"กำลังรอสัญญาณจาก Creator..." for the whole broadcast while chat worked fine.

**LiveKit is not the problem.** The egress record for the 2:24 session:

```
EG_vJWbPiuo9fbU   status EGRESS_COMPLETE   error ""   error_code 0
stream.info[0]    rtmp://global.rtmp.mediadelivery.net/live/{bun…99d}
                  status FINISHED   duration 133.42s   error ""   retries 0
```

133 seconds of RTMP delivered to Bunny, no errors, no retries.

**Bunny received it and read the video header.** `metadata.bunny_final` on that
session has `width: 1280, height: 720, framerate: 30` — and on the session
before it, `1920x1080`, matching the creator's quality choice. A Bunny live
stream that has never been ingested has all three as `null` (verified twice on
throwaway streams). Nothing in the create payload sends a resolution, so the
only way Bunny knows is from the RTMP handshake.

**And then it does nothing with it.** On the same object, at end of session:

```
status: 1            (still "created" — never went live)
startedAt: null
durationSeconds: null
availableResolutions: null
```

Bunny also fires webhook `Status: 14` at go-live and `Status: 15` exactly
~16 seconds later, in every session, while the broadcast runs on for minutes.
A fixed 16-second interval is a timeout, not a stream ending.

So: **ingest accepted, header parsed, no transcode, no playlist.** The viewer's
404-retry loop was correct and there was simply never anything to fetch.

### What this is almost certainly not

- Not the URL suffix. `bunny_playback_url` is stored verbatim from Bunny's own
  `playbackUrlHls`; nothing is constructed client-side.
- Not player patience. The retry budget is 40 × 3s = 120s, longer than one of
  the failing sessions.
- Not LL-HLS vs standard HLS. That would change latency, not produce zero
  segments.

### What could not be tested from here

The pull zone (`vz-46d7a368-5c3.b-cdn.net`) returns **403 to this
infrastructure for every path**, including a known-good VOD playlist that the
app plays fine. So no manifest can be fetched for diagnosis from a server;
that has to be done from a browser.

`GET https://api.bunny.net/videolibrary/740127` — which would show the
library's live-streaming configuration — returns **401** with
`bunny_stream_api_key`, because that key is library-scoped. Reading library
settings needs the ACCOUNT-level API key, which is not in the vault.

### What CEO Por needs to check (5 minutes, dashboard)

1. `dash.bunny.net/stream/740127` → is this library actually **enrolled in the
   Live Streaming preview**? Bunny gates it per-library behind a signup banner.
   The API accepting `POST /library/740127/live` does not prove the transcoding
   pipeline is provisioned — everything observed is consistent with the API
   being available and the pipeline not being.
2. In the same dashboard, open the live stream while broadcasting and see
   whether Bunny shows a preview. If Bunny's own player shows nothing, this is
   entirely vendor-side and no client change will fix it.
3. If it is enrolled: raise a Bunny support ticket with stream guid
   `01a05da4-f559-715a-a872-a387a766c34d` and the fact that ingest was accepted
   (width/height populated) but `startedAt` stayed null.
4. Optional but useful: add the **account-level** Bunny API key to the vault so
   library settings can be read programmatically instead of by hand.

### What shipped anyway

The pipeline is correct and instrumented; it is waiting on the vendor.

- `live-get-playback-url` now returns `ingest_ready` and `bunny_status`, read
  from Bunny per request, and logs a warning when Bunny has not started. That
  single field is what would have identified this in seconds.
- The player tells a 403 apart from a 404. A 403 is the CDN refusing the viewer
  (token, expiry, hotlink or geo rule) and is now a real error instead of being
  retried for two minutes as if the creator were late.
- After the retry budget is spent the viewer is told the stream is not being
  delivered, rather than left on a spinner forever; while waiting they see an
  elapsed counter against the stated ceiling.

## 5b. Delivery is now a runtime switch, defaulting to LiveKit

Because §5a is vendor-side and unresolved, viewer delivery is selected at
runtime by the vault secret **`live_delivery_mode`**, read on every
`live-create-session` create:

| value | viewers get | cost | status |
|---|---|---|---|
| `livekit` (**current**) | a direct subscription to the creator's LiveKit room | ~2.26 THB/viewer-hour | known to work |
| `llhls` | a Bunny LL-HLS playlist via hls.js | ~0.30 THB/viewer-hour | blocked on §5a |

Flip it with one SQL statement — **no deploy, no code change**:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'live_delivery_mode'),
  'llhls'
);
```

In `livekit` mode `live-create-session` skips the Bunny create entirely (no
orphan objects) and skips the egress (no wasted egress billing), and stamps the
session `latency_mode: 'ultra_low'` because WebRTC has no CDN in the path.
Everything else is unchanged, and nothing else needed changing — the dual-path
design was already in place:

- `live-get-playback-url` returns a LiveKit subscriber token for any session
  with no `bunny_playback_url`.
- `LiveWatchView` already renders `LiveKitLivePlayer` for `delivery: 'livekit'`.
- `CreatorBroadcaster` already skips `start_egress` when delivery is not llhls.

One deliberate difference between the modes: **simulcast is on only under
LiveKit delivery.** Under LL-HLS the room's single subscriber is the egress and
it always wants the top layer, so the spare encodes are wasted CPU on a machine
already running the filter canvas. Under LiveKit delivery every viewer is a
subscriber and a phone on Thai mobile data cannot hold 3 Mbps — without
simulcast it gets a stuttering 720p instead of a clean 360p.

**What is preserved in either mode:** Supabase Realtime chat and reactions,
presence viewer counts, the chat counter, the mobile 16:9 layout, camera
filters burned into the published track, the kill switch, and the login gate.

## 5c. Correcting the record: the Bunny IDs are real

A report on 2026-09-01 concluded that `live-create-session` fabricates Bunny
IDs locally and never calls the Bunny API. It does not, and the "fix" it
proposed — creating live streams at `POST /library/{id}/videos` and
constructing `rtmp://ingest.b-cdn.net/{library_id}` — would have replaced
working code with something that cannot work. Recorded here so it is not
re-litigated:

- **Nothing in the codebase generates an id.** `grep -rn 'randomUUID\|uuid\|
  bunnylive_'` over `supabase/functions/live-*` and `_shared/live.ts` returns
  nothing. `bunny_stream_id` is `bunny.guid`, read off the parsed HTTP
  response; on a Bunny failure `bunny` is null and the columns are null.
- **The formats called fabricated are Bunny's own.** A live create issued by
  hand returned `guid: 01a05de6-e9fa-73fd-8ac8-590d807dccd4` and
  `streamKey: bunnylive_76c47c07e6d4408ba50adb1c0d65eb85`. The guids are
  UUIDv7, which is why they share a `01a05…` prefix — they sort by creation
  time. The `bunnylive_` prefix is Bunny's.
- **`playbackUrlHls` is Bunny's too**, including the filename: Bunny returns
  `…/live/{guid}/live.m3u8`. It is stored verbatim; the app constructs no
  playback URL.
- **The 404s came from the wrong endpoint and from our own cleanup.** Live
  streams live at `/library/{id}/live/{guid}`. They also resolve at
  `/videos/{guid}` — a probe stream returned 200 on both. Ended sessions 404 on
  both because `live-end-session` deletes every stream that recorded nothing.
  That is the same reason the library shows zero live streams between sessions.
- **The strongest proof is already in the database.** `metadata.bunny_final` on
  session `0afeb2e9-…` holds a complete Bunny object — `dateCreated
  2026-09-01T15:44:46.937`, `streamKey bunnylive_65120b0d…`, full
  `ingestEndpoints` — fetched by an authenticated GET on that supposedly fake
  id. A fabricated id cannot return that.
- **"Bunny cost = 0" is our own estimator**, not a Bunny reading:
  `durationMinutes × peakViewers × 0.0039 THB`. One viewer for two minutes is
  0.01 THB.

`POST /videos` returns no `streamKey` and no `ingestEndpoints`, so RTMP could
not be addressed at all; and the ingest host is account- and region-dependent,
which is why it is read from Bunny's response rather than hardcoded.

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
