# The bench's landscape test broadcast

A 1280 × 720 (16:9) still, packaged as short VOD HLS playlists so
`/dev/live-mobile` can drive the REAL player — `HlsLivePlayer` through
`lib/live/hlsPlayer.ts`, hls.js and all — instead of a black waiting state.
It exists to answer one question that a screenshot of the waiting state
cannot: does a LANDSCAPE source fill a portrait phone edge to edge, or does
it letterbox?

So the frame is built to make a black bar impossible to miss, and to have
no dark region of its own that could be mistaken for one:

  - a bright diagonal gradient over the whole frame — nothing near black;
  - a **lime** band along the source's TOP edge, captioned `TOP EDGE`;
  - a **magenta** band along its BOTTOM edge, captioned `BOTTOM EDGE`;
  - **blue** bands down both SIDES.

Under `object-fit: cover` on a 375 × 812 phone the lime and magenta bands
sit hard against the top and bottom of the screen and the blue side bands
are cropped away — that is the correct result, and it is what a 16:9
desktop broadcast is supposed to look like on a phone. A black band above
or below the picture means the letterbox is back. Blue visible down both
sides means the video is being contained rather than covering.

Dev-only: `app/dev/live-mobile/page.tsx` returns `notFound()` when
`VERCEL_ENV === 'production'`.

## Two renditions

`index.m3u8` is H.264 in MPEG-TS: what production streams, what every real
phone decodes, and the bench's default.

`index-vp9.m3u8` is the same still as VP9 in fMP4. It exists because a stock
Chromium build — Playwright's, and so any screenshot taken in CI — ships
without H.264: `MediaSource.isTypeSupported` for `avc1` is false there,
hls.js attaches a MediaSource and no frame ever arrives, and the resulting
black screen is indistinguishable from the letterbox the screenshot was
taken to disprove. The bench picks between them with that same
`isTypeSupported` check.

The H.264 segment is `.mpegts` rather than the conventional `.ts` so that
`tsc` does not try to parse a binary transport stream as TypeScript —
`tsconfig.json` includes `**/*.ts` across the repo. hls.js fetches segments
as an ArrayBuffer and never looks at the extension.

## Regenerating

A still looped to six seconds rather than moving footage: it is 112 KB
instead of 800 KB, and nothing being checked here moves.

    VF="drawtext=text='TOP EDGE OF THE 16\:9 SOURCE':fontcolor=black:fontsize=34:x=(w-text_w)/2:y=40,\
    drawtext=text='BOTTOM EDGE OF THE 16\:9 SOURCE':fontcolor=black:fontsize=34:x=(w-text_w)/2:y=h-80,\
    drawtext=text='1280 x 720  •  16\:9 LANDSCAPE':fontcolor=white:fontsize=52:box=1:boxcolor=black@0.55:boxborderw=16:x=(w-text_w)/2:y=(h-text_h)/2,\
    drawbox=x=0:y=0:w=1280:h=22:color=0x39FF14@1:t=fill,\
    drawbox=x=0:y=698:w=1280:h=22:color=0xFF00E5@1:t=fill,\
    drawbox=x=0:y=0:w=22:h=720:color=0x001AFF@1:t=fill,\
    drawbox=x=1258:y=0:w=22:h=720:color=0x001AFF@1:t=fill"

    ffmpeg -y -f lavfi -i "gradients=size=1280x720:c0=0xFF9F0A:c1=0xFFD60A\
    :c2=0x30D158:c3=0x64D2FF:c4=0xBF5AF2:c5=0xFF375F:n=6:type=linear\
    :x0=0:y0=0:x1=1280:y1=720:duration=1:rate=1" -vf "$VF" -vframes 1 frame.png

    ffmpeg -y -loop 1 -framerate 10 -i frame.png -t 6 -c:v libx264 \
      -profile:v baseline -level 3.1 -pix_fmt yuv420p -crf 28 -g 60 -an \
      landscape-720p.mp4

    ffmpeg -y -i landscape-720p.mp4 -c copy -f hls -hls_time 2 \
      -hls_playlist_type vod -hls_list_size 0 -hls_flags single_file \
      -hls_segment_filename landscape-720p.mpegts index.m3u8

    ffmpeg -y -i landscape-720p.mp4 -c:v libvpx-vp9 -crf 36 -b:v 0 -g 60 \
      -deadline good -cpu-used 4 -row-mt 1 -pix_fmt yuv420p -an \
      -f hls -hls_time 2 -hls_playlist_type vod -hls_list_size 0 \
      -hls_segment_type fmp4 -hls_fmp4_init_filename vp9-init.mp4 \
      -hls_segment_filename vp9-%d.m4s index-vp9.m3u8

`frame.png` and `landscape-720p.mp4` are not committed — they are only the
intermediates both packagings are cut from.
