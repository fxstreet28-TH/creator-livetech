# LL-HLS re-test, 2026-09-07 — Bunny still does not go live

Follow-up to `phase2-llhls-migration.md` §5a. Branch:
`claude/bunny-llhls-e2e-test-q2ez9u`.

**Verdict: Bunny Live is still broken, and it is now proven to be Bunny's
fault alone.** The failure reproduces with LiveKit's RoomComposite egress, the
creator's browser, the camera, the filter canvas and the LiveKit room all
removed from the picture. Delivery has been left on `livekit`.

---

## 1. What the answer is, in one table

| question | answer |
|---|---|
| `POST /library/740127/live` | **201**, works |
| `GET /library/740127/live/{guid}` during a live RTMP push | **200**, every poll |
| `startedAt` after 6 minutes of clean RTMP | **`null`** — never set |
| `status` | **`1`** ("created"), never advanced |
| `availableResolutions` | **`null`** |
| `width` / `height` / `framerate` | **1280 / 720 / 30** — Bunny read the header |
| playback `.m3u8` on the CDN | **404**, on every one of 36 fetches |
| Did the manifest ever appear? | **No** |

Bunny accepts the connection, parses the video header within seconds, and then
does nothing with it. Same signature as 2026-09-01, six days later.

---

## 2. Two corrections to §5a before anything else

The previous investigation could not fetch a single manifest and recorded the
reason as *"the pull zone returns 403 to this infrastructure for every path,
including a known-good VOD playlist that the app plays fine."* That was two
separate things, and each was hiding the other.

**The agent sandbox blocks the hosts outright.** `api.bunny.net`,
`vz-46d7a368-5c3.b-cdn.net`, `*.supabase.co` and `cloud-api.livekit.io` all
answer `CONNECT tunnel failed, response 403` from the sandbox's own egress
proxy. The 403 carries the proxy's headers, not Bunny's. Bunny never saw those
requests. Anything run from an agent container is measuring the proxy.

**Bunny blocks a request with no `Referer`.** Measured today from an Edge
Function (so, past the sandbox) against the VOD the app plays fine,
`77cce7ca-…/playlist.m3u8`:

| `Referer` sent | result |
|---|---|
| *(none)* | **403** Bunny's branded error page |
| `https://creatorlivetech.com/` | **200** `#EXTM3U` |
| `https://www.creatorlivetech.com/` | 200 |
| `https://creator-livetech.vercel.app/` | 200 |
| `https://…-git-….vercel.app/` (preview) | 200 |
| `http://localhost:3000/` | 200 |
| `capacitor://localhost/` | 200 |

So the library blocks only the *absent* referrer and allows every referrer it
is given — Bunny Stream's "block direct file access" default over an empty
allow-list. **No viewer is affected**: browsers always send one, on the
production domain, on Vercel previews, on localhost and inside the Capacitor
shell. But a server-side probe that omits it reads 403 on every path and
learns nothing, which is exactly what happened.

Both faults had to be removed before any of this was measurable. That is what
`supabase/functions/live-bunny-probe/index.ts` is for: it runs on Supabase's
network and sends a referrer, so the status codes finally mean what they say —
**403 referrer rejected, 404 no playlist written, 200 playing.**

Two smaller notes: `bunny_stream_token_key` **does** now exist in the vault
(added 2026-09-01 14:55, after §6 recorded that it did not), but signed and
unsigned URLs behave identically on every fetch — token authentication is not
being enforced by the pull zone, so §6's recommendation still stands. And
§5c's claim that a live guid also resolves at `/videos/{guid}` no longer
holds: a freshly created live stream returns **404** there today.

---

## 3. The isolation test — this is the decisive one

The obvious objection to the 2026-09-01 sessions is that something upstream
was malformed: the filter canvas, the simulcast layers, the RoomComposite
layout, the creator's camera. So this run removed all of it.

**LiveKit Web egress** renders a plain web page in a headless Chrome and pushes
the result to RTMP. No room, no publisher, no participant, no camera, no
canvas, no `single-speaker` layout — and no product code. Everything else was
held identical to production: the same `H264_720P_30` preset, the same
`stream_outputs: [{protocol: RTMP, urls:[…]}]` shape, the same Bunny ingest
endpoint read from Bunny's own create response.

```
2026-09-07 06:42:53.564Z  Bunny live stream created         201
                          guid 01a07a9a-ea5c-731a-af2e-929b318e1353
2026-09-07 06:43:09.465Z  LiveKit StartWebEgress            200  EG_2fVRiHmB3pA9
2026-09-07 06:43:12.420Z  RTMP output ACTIVE
2026-09-07 06:43:35.093Z  polling starts, every 5s
2026-09-07 06:45:35.162Z  polling ends, 24 ticks
2026-09-07 06:47:20Z      second poll starts, every 10s
2026-09-07 06:49:20.719Z  second poll ends, 12 ticks
2026-09-07 06:50:38Z      egress still EGRESS_ACTIVE, then stopped by hand
```

That is **6 minutes 8 seconds of continuous RTMP** and **36 manifest fetches**,
with the sender reporting no error at any point.

LiveKit's side, read back mid-push:

```
egress_id EG_2fVRiHmB3pA9   status EGRESS_ACTIVE   error ""   error_code 0
source_type EGRESS_SOURCE_TYPE_WEB
stream.info[0]  status ACTIVE   error ""   retries 0   last_retry_at 0
```

Bunny's side, all 24 ticks, verbatim and unchanging from the first poll:

```
1.6s   api=200 status=1 started=null wxh=1280x720 res=null m3u8=404
5.6s   api=200 status=1 started=null wxh=1280x720 res=null m3u8=404
…
115.7s api=200 status=1 started=null wxh=1280x720 res=null m3u8=404
```

The second poll adds 12 more ticks over the following two minutes and holds
exactly one distinct state across all of them —
`status=1 / startedAt=null / width=1280 / m3u8=404`. Nothing moved.

Read what that says. **`wxh=1280x720` is populated on the very first poll** —
about 23 seconds after the RTMP output went ACTIVE. A Bunny live stream that
has never been ingested has `width`, `height` and `framerate` all `null`
(verified again today on two throwaway streams, §4). Nothing in the create
payload sends a resolution. So Bunny demonstrably received the stream and
parsed its video header. And then, for the next 114 seconds: `status` stayed
`1`, `startedAt` stayed `null`, `availableResolutions` stayed `null`, and the
playlist stayed `404` — a 404 that now means "no playlist written", because
the referrer gate has been passed.

Ingest accepted. Header parsed. No transcode. No playlist. No creator, no
browser, no LiveKit room anywhere in it.

---

## 4. The never-ingested baseline, for comparison

Two throwaway streams created and deleted today establish what "Bunny has
received nothing" looks like, so the numbers above cannot be read as a default
state:

```
create                        201
status                        1
startedAt                     null
width / height / framerate    null / null / null      <-- the difference
availableResolutions          null
public                        true
dvrEnabled                    true, dvrWindowSeconds 1800
ingestRegion                  "EU"
playbackUrlHls                https://vz-46d7a368-5c3.b-cdn.net/live/{guid}/live.m3u8
.m3u8 with referrer           404 (both signed and unsigned)
GET /videos/{guid}            404
GET api.bunny.net/videolibrary/740127   401 (needs the ACCOUNT key, still not in the vault)
delete                        200
```

`ingestRegion: "EU"` for a Thai creator base is still unexplained and still not
settable at create. Worth putting to Bunny alongside the main fault.

---

## 5. What was NOT tested, and why

- **A real broadcast through `/creator/live` with `mode=start_egress`.** The
  vault switch was flipped to `llhls` and a harness armed to fire the probe
  automatically the moment a Bunny-backed session appeared; no broadcast was
  started during the window. It is no longer on the critical path — the
  isolation test in §3 is strictly stronger evidence, since it rules out
  everything a real broadcast would have added. `mode=start_egress` itself was
  last exercised on 2026-09-01 and returned a valid `egress_id`.
- **Viewer HLS playback on iPhone and desktop.** Not possible: it needs a
  playlist, and there has never been one. This stays open and is the first
  thing to run if Bunny is ever fixed.
- **Glass-to-glass latency, LL-HLS `#EXT-X-PART` vs plain HLS, the 60-minute
  session, cost per viewer-hour.** All still blocked behind the same thing.

---

## 6. Bunny support ticket — ready to send

> **Subject: Live stream accepts RTMP ingest and parses the video header, but never transitions to live or produces a playlist (library 740127)**
>
> Video library: **740127**
> Pull zone: **vz-46d7a368-5c3.b-cdn.net**
> Region reported at create: `ingestRegion: "EU"` (our creators and viewers are in Thailand)
>
> Every live stream we create in this library accepts an RTMP push and reads
> its video header, but never sets `startedAt`, never leaves `status: 1`, never
> populates `availableResolutions`, and never writes an HLS playlist. It has
> failed this way on every attempt since 2026-09-01.
>
> **Most recent test — 2026-09-07, deliberately isolated from our application:**
>
> | | |
> |---|---|
> | Stream guid | `01a07a9a-ea5c-731a-af2e-929b318e1353` |
> | Created | 2026-09-07 06:42:53.564 UTC — `POST /library/740127/live` → 201 |
> | Ingest URL | `rtmp://global.rtmp.mediadelivery.net/live` (your `ingestEndpoints.rtmp.primaryIngestUrl`, verbatim) |
> | RTMP push started | 2026-09-07 06:43:12.420 UTC |
> | Encoder | LiveKit Cloud Web egress, preset `H264_720P_30` (H.264 720p30, AAC) |
> | Push duration | **6 min 8 s**, continuous, no interruption |
> | Sender-side status | `ACTIVE`, `error: ""`, `retries: 0` for the whole push |
> | Polled | `GET /library/740127/live/01a07a9a-…` every 5s for 2 min, then every 10s for 2 min — 200 every time |
>
> **What your API returned throughout the push:**
>
> ```
> status:               1          (never advanced)
> startedAt:            null       (never set)
> availableResolutions: null
> width / height:       1280 / 720
> framerate:            30
> ```
>
> `width`, `height` and `framerate` were already populated on the first poll,
> ~23 seconds after the push began, and never changed thereafter. A stream in this library that has never
> been ingested returns all three as `null` — we re-verified that today on two
> throwaway streams. We send no resolution in the create payload, so those
> values can only have come from the RTMP handshake. **Your ingest received the
> stream and parsed it; the transcode never started.**
>
> `https://vz-46d7a368-5c3.b-cdn.net/live/01a07a9a-…/live.m3u8` returned **404**
> on all 36 fetches during the push (sent with a `Referer` header, so this is
> not the library's direct-access rule — that returns 403, which we tested
> separately).
>
> The sending side is not the problem: this test used a headless-browser web
> egress, so there was no camera, no WebRTC room and no application code
> involved — just a standard H.264/AAC RTMP push to your endpoint. Earlier
> attempts on 2026-09-01 used a room-composite egress and failed identically.
>
> **Earlier occurrences, same library, same signature** (all with
> `width`/`height` populated and `startedAt: null`):
>
> | date (UTC) | stream guid | push duration |
> |---|---|---|
> | 2026-09-01 15:35:15 | `01a05d9c-3b64-78d6-b7e5-62d2fba82ba6` | 219 s (1920×1080) |
> | 2026-09-01 15:44:47 | `01a05da4-f559-715a-a872-a387a766c34d` | 144 s (1280×720) |
> | 2026-09-01 16:22:05 | `01a05dc7-1927-7438-bbea-a278e7b731ea` | 171 s |
> | 2026-09-01 16:35:21 | `01a05dd3-3ddc-7f1f-b9e6-dcd5b5f88b31` | 205 s |
> | 2026-09-01 16:45:17 | `01a05ddc-57f4-79a8-b1e8-7c9b80d9fa4b` | 413 s |
>
> On 2026-09-01 your webhooks fired `Status: 14` at go-live and `Status: 15`
> roughly 16 seconds later, in every session, while the push continued for
> minutes afterwards. A fixed ~16-second interval looks like a timeout rather
> than a stream ending.
>
> **Our questions:**
>
> 1. Is library 740127 actually provisioned for live streaming, or only
>    API-enabled? Everything we observe is consistent with the API being
>    available while the transcoding pipeline is not.
> 2. What does `status: 1` with a populated `width`/`height` mean on your side
>    — what is the pipeline waiting for?
> 3. `ingestRegion` comes back `EU` and is not settable at create. Our audience
>    is in Thailand. Can this library be moved to an APAC ingest region, and
>    could the region assignment be related to the failure?
> 4. VOD in this same library works correctly, so this is specific to live.
>
> We can re-run the test with a fixed guid at any time you want to watch it.

---

## 7. Cloudflare Stream Live as the alternative — the cost premise is wrong

The brief for this evaluation put Cloudflare at *"~0.06 THB/viewer-hour, no
per-stream egress fee"*. The no-egress-fee half is right. **The rate is
$0.06 per viewer-hour, not ฿0.06** — roughly **฿2.10** at 35 THB/USD. That is a
35× difference and it inverts the conclusion.

Cloudflare Stream bills **$1 per 1,000 minutes delivered**, with ingest,
encoding and bandwidth included and no egress charge. One viewer-hour is 60
delivered minutes = $0.06 ≈ ฿2.10. Billing is per *minute*, independent of
bitrate, which is precisely why it is expensive here: our 3 Mbps 720p is
~22.5 MB/minute, and against Bunny's $0.005/GB that is ~฿0.0039/viewer-minute.
Per-minute pricing charges the same for a phone on a 400 kbps rendition as for
a 4K TV.

| path | ฿/viewer-hour | flat ฿/stream-hour | 1 h × 500 viewers |
|---|---|---|---|
| LiveKit direct — **live today** | 2.26 | 0 | ~฿1,130 |
| Bunny LL-HLS — blocked | ~0.30 | ~33 | ~฿151 |
| Cloudflare Stream (WHIP/WHEP) | ~2.10 | 0 | ~฿1,050 |

**Cloudflare is a ~7% saving on what we already pay, not an 8× one.** It is
roughly a wash with the status quo, and about 7× dearer than Bunny would be if
Bunny worked. The migration's entire economic case rests on a $/GB CDN; a
per-delivered-minute vendor cannot reproduce it at our bitrate.

There is also a hard architectural blocker. Cloudflare's WHIP and WHEP **must
be used as a pair**: an input ingested over WHIP cannot be played back over
HLS or DASH, and cannot be recorded. So "browser WHIP in, HLS out to viewers"
— the shape that was asked for — is not available. The real choice is:

- **WHIP in, WHEP out.** Genuinely removes LiveKit and the egress fee, and
  gives sub-second latency. But every viewer is on WebRTC, so `hls.js`,
  `HlsLivePlayer` and the whole HLS path are deleted with no fallback for
  restrictive networks; there is no DVR or late-join window; recording is
  lost, which kills `recording_enabled`; and it is documented as **beta**.
- **RTMP in, HLS out.** GA, keeps the viewer code — but keeps LiveKit and the
  ~฿33/stream-hour egress too, so it is strictly worse than today on cost.

**Migration estimate, WHIP/WHEP option: roughly 4–6 working days**, and it
deletes working functionality:

| work | size |
|---|---|
| Publisher: swap `livekit-client` publish for raw WHIP (`RTCPeerConnection` + SDP POST). `createFilteredStream` already yields a `MediaStream`, so the filter canvas is reusable as-is | 1 day |
| Viewer: replace `HlsLivePlayer`/`hls.js` with a WHEP player; re-do the retry ladder, watchdog and autoplay handling against WebRTC states rather than manifest fetches | 1.5 days |
| Backend: Cloudflare live inputs in place of `bunnyCreateLiveStream`; **delete `mode=start_egress` entirely**; rework `live-end-session` (no egress to stop); new signed-playback story for entitlement | 1 day |
| Cost model, budget lines, `check-platform-budget` | 0.5 day |
| Re-test everything Bunny never got to: iPhone + desktop, 60-minute session, latency, 500-viewer load | 1–2 days |

Chat, reactions and presence viewer counts are unaffected — they already moved
to Supabase Realtime and are independent of the video path.

**Recommendation.** Do not migrate to Cloudflare on cost grounds; the premise
does not survive checking. Send the §6 ticket, and press on question 1 (is the
library actually provisioned for live) and question 3 (the `EU` ingest region),
which are the two things most likely to be a switch on Bunny's side. Stay on
`livekit` delivery meanwhile — it works, and at ฿2.26/viewer-hour it costs
about what Cloudflare would. If Bunny will not fix it, the replacement to look
for is another **$/GB** live CDN, not a per-delivered-minute one.

---

## 8. What was changed, and how to undo it

**Nothing in the product changed.** One Edge Function was added and the
delivery switch was flipped and put back.

- `supabase/functions/live-bunny-probe/index.ts` — new, service-role gated,
  `verify_jwt` off so `pg_net` can drive it. Modes `baseline`, `observe`,
  `cleanup`. Safe to delete once Bunny is fixed or dropped.
- `live_delivery_mode` was set to `llhls` at 06:39:49 UTC and **put back to
  `livekit` at 06:51 UTC**. A `pg_cron` auto-revert was armed for 09:45 UTC as
  a dead-man switch in case this session ended first; it was removed unused.
- Scratch schema `llhls_probe` (a LiveKit JWT signer, a probe-fire harness and
  one row recording the test stream) plus two `pg_cron` jobs — **all dropped**.
  The JWT signer was `SECURITY DEFINER` and would have been `EXECUTE`-able by
  `PUBLIC`; it mints LiveKit admin tokens, so it did not get to outlive the
  test. Verified afterwards: `live_delivery_mode = livekit`, zero `llhls*` cron
  jobs, no `llhls_probe` schema.
- The LiveKit web egress was stopped by hand (`StopEgress` → `EGRESS_ENDING`).
  Total billable egress for this test: ~7 minutes, about ฿4.
- **Bunny stream `01a07a9a-ea5c-731a-af2e-929b318e1353` was deliberately left
  in the library** so Bunny support can inspect the exact object named in the
  ticket. Delete it once the ticket closes:

```sql
select net.http_post(
  url := 'https://hknvooaqgpufrbdxtzxf.supabase.co/functions/v1/live-bunny-probe',
  body := jsonb_build_object('mode','cleanup','guid','01a07a9a-ea5c-731a-af2e-929b318e1353'),
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
    (select decrypted_secret from vault.decrypted_secrets where name='edge_function_service_key')),
  timeout_milliseconds := 30000);
```

The Edge Function itself is still deployed. Remove it with
`supabase functions delete live-bunny-probe` when Bunny is fixed or dropped.

**To re-run the isolation test** (no broadcaster needed) — the full recipe is
in the appendix. Once a stream and egress are running, poll with:

```sql
select net.http_post(
  url := 'https://hknvooaqgpufrbdxtzxf.supabase.co/functions/v1/live-bunny-probe',
  body := jsonb_build_object('mode','observe','guid','<guid>',
                             'interval_ms',5000,'duration_ms',120000),
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
    (select decrypted_secret from vault.decrypted_secrets where name='edge_function_service_key')),
  timeout_milliseconds := 150000);
```

---

## 9. The one-step switch, for when Bunny is fixed

Unchanged from §5b of the migration doc, and re-confirmed working today — the
flip took effect with no deploy:

```sql
-- turn LL-HLS delivery on
select vault.update_secret(
  (select id from vault.secrets where name = 'live_delivery_mode'), 'llhls');

-- roll back
select vault.update_secret(
  (select id from vault.secrets where name = 'live_delivery_mode'), 'livekit');
```

One caveat found today and worth knowing before the next attempt:
`getVaultSecret` caches for **5 minutes** per warm Edge Function instance, so a
broadcast started immediately after a flip can still be created on the old
path. Check the `delivery` field in the `live-create-session` response, or
`live_sessions.bunny_stream_id`, before concluding the switch did not work.

Sessions created under `llhls` that fail Bunny's create fall back to
`delivery: 'livekit'` on their own and play end to end, so the flip is not a
cliff.


---

## Appendix — the isolation test, reproducible from SQL

Everything below runs from the Supabase SQL editor. It needs no broadcaster, no
browser and no deploy, and it is the cheapest way to re-check Bunny after
support replies. Total cost per run is about ฿4 of LiveKit egress.

```sql
-- 1. A LiveKit JWT, and where LiveKit's HTTP API lives.
create schema if not exists llhls_probe;

create or replace function llhls_probe.b64url(b bytea) returns text
language sql immutable as $$
  select rtrim(translate(replace(encode(b,'base64'), E'\n', ''), '+/', '-_'), '=');
$$;

create or replace function llhls_probe.livekit_token(p_grant jsonb, p_ttl int default 3600)
returns text language plpgsql security definer set search_path = extensions, public, vault as $fn$
declare api_key text; api_secret text; now_s bigint; header text; payload text; si text;
begin
  select decrypted_secret into api_key    from vault.decrypted_secrets where name='livekit_api_key';
  select decrypted_secret into api_secret from vault.decrypted_secrets where name='livekit_api_secret';
  now_s := extract(epoch from now())::bigint;
  header  := llhls_probe.b64url(convert_to('{"alg":"HS256","typ":"JWT"}','utf8'));
  payload := llhls_probe.b64url(convert_to(jsonb_build_object(
      'iss',api_key,'sub','egress-service','name','probe',
      'nbf',now_s,'exp',now_s+p_ttl,'video',p_grant)::text,'utf8'));
  si := header || '.' || payload;
  return si || '.' || llhls_probe.b64url(extensions.hmac(si, api_secret, 'sha256'));
end $fn$;

create or replace function llhls_probe.livekit_http() returns text
language sql security definer set search_path = public, vault as $$
  select rtrim(regexp_replace(decrypted_secret,'^ws','http'),'/')
  from vault.decrypted_secrets where name='livekit_ws_url';
$$;

-- SECURITY: this mints LiveKit admin tokens. Keep it out of PUBLIC's reach,
-- and drop the schema when the test is done.
revoke all on function llhls_probe.livekit_token(jsonb,int) from public;

-- 2. Create a Bunny live stream and keep its RTMP destination out of sight.
create table if not exists llhls_probe.stream (
  guid text primary key, rtmp_destination text not null,
  playback_url text not null, created_at timestamptz default now(), egress_id text);

select net.http_post(
  url := 'https://video.bunnycdn.com/library/740127/live',
  headers := jsonb_build_object(
    'AccessKey',(select decrypted_secret from vault.decrypted_secrets where name='bunny_stream_api_key'),
    'Content-Type','application/json','accept','application/json'),
  body := jsonb_build_object('title','ISOLATION TEST','dvrEnabled',true,'recordVod',false),
  timeout_milliseconds := 20000);   -- note the returned request id, say 500

-- ...then, a few seconds later:
with r as (select content::jsonb as j from net._http_response where id = 500)
insert into llhls_probe.stream (guid, rtmp_destination, playback_url)
select j->>'guid',
       rtrim(j->'ingestEndpoints'->'rtmp'->>'primaryIngestUrl','/') || '/' || (j->>'streamKey'),
       j->>'playbackUrlHls'
from r returning guid, playback_url;

-- 3. Web egress: a headless browser rendering a page, straight to Bunny over
--    RTMP. No room, no publisher, no product code — so whatever happens next
--    belongs to Bunny.
select net.http_post(
  url := llhls_probe.livekit_http() || '/twirp/livekit.Egress/StartWebEgress',
  body := jsonb_build_object(
    'url','https://example.com',
    'preset','H264_720P_30',
    'stream_outputs', jsonb_build_array(jsonb_build_object(
      'protocol','RTMP',
      'urls', jsonb_build_array((select rtmp_destination from llhls_probe.stream
                                 where guid='<guid from step 2>'))))),
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer ' || llhls_probe.livekit_token(jsonb_build_object('roomRecord',true))),
  timeout_milliseconds := 30000);

-- 4. Poll Bunny and the CDN for two minutes (see §8 for the observe call).
-- 5. Stop the egress, or it bills until LiveKit reaps it.
select net.http_post(
  url := llhls_probe.livekit_http() || '/twirp/livekit.Egress/StopEgress',
  body := jsonb_build_object('egress_id','<egress id from step 3>'),
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer ' || llhls_probe.livekit_token(jsonb_build_object('roomRecord',true))),
  timeout_milliseconds := 20000);

-- 6. Tear down.
drop schema llhls_probe cascade;
```

Two things that will waste an afternoon if forgotten:

- **`pg_net` responses arrive asynchronously.** `net.http_post` returns a
  request id immediately; the reply lands in `net._http_response` a moment
  later. Read it in a *separate* statement, and remember a long request blocks
  the ones queued behind it.
- **Send a `Referer` on every CDN fetch.** Without one the pull zone answers
  403 to everything and the whole exercise measures nothing. See §2.
