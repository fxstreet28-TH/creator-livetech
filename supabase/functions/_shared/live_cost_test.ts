/**
 * Unit tests for what a finished broadcast is billed, and for the one field
 * that decides it.
 *
 *   deno task test
 *
 * WHY THIS FILE EXISTS. `estimated_cost_thb` is not a cosmetic figure on a
 * creator's summary screen: closeLiveSession posts it to
 * `platform_budget_state`, and `check_creator_can_golive` refuses go-lives once
 * that total crosses a threshold. So a session priced for a vendor it never
 * touched does not just over-charge one creator — it walks the whole platform
 * toward its own kill switch. On 2026-09-10 that happened for real: every
 * self-hosted LiveKit session fell through to the 'llhls' branch and was
 * charged ~0.56 THB/minute of Bunny CDN egress for a CDN that was not in the
 * path, and session 9595d27e-fc6d-47d0-990f-f521c95fcc0b had to be refunded by
 * hand with the budget row rolled back after it.
 *
 * The arithmetic below needs no database, no vault and no deployed function to
 * be wrong, which is exactly why it is worth pinning down here.
 */

import {
  bunnyThbPerViewerMinute,
  estimateLiveCost,
  LIVE_COST_MODEL,
  LIVEKIT_THB_PER_STREAM_MINUTE,
  PUBLISH_MBPS_BY_QUALITY,
  storedDeliveryMode,
} from './live.ts';

/** Same helper, and the same reasoning, as stars_test.ts: no remote imports. */
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual) ?? 'undefined';
  const b = JSON.stringify(expected) ?? 'undefined';
  if (a !== b) throw new Error(`${msg ?? 'not equal'}\n  actual:   ${a}\n  expected: ${b}`);
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// storedDeliveryMode
// ---------------------------------------------------------------------------

Deno.test('storedDeliveryMode: reads every mode a row may name', () => {
  assertEquals(storedDeliveryMode({ delivery_mode: 'livekit' }), 'livekit');
  assertEquals(storedDeliveryMode({ delivery_mode: 'llhls' }), 'llhls');
  assertEquals(storedDeliveryMode({ delivery_mode: 'origin' }), 'origin');
  assertEquals(storedDeliveryMode({ delivery_mode: 'livekit_selfhost' }), 'livekit_selfhost');
});

Deno.test('storedDeliveryMode: null for anything it cannot vouch for', () => {
  // The case that matters most: every row written before the field existed.
  // Null is what sends the caller to its own fallback, and a wrong non-null
  // here would reprice history.
  assertEquals(storedDeliveryMode({}), null, 'no key');
  assertEquals(storedDeliveryMode(null), null, 'null metadata');
  assertEquals(storedDeliveryMode(undefined), null, 'absent metadata');
  assertEquals(storedDeliveryMode({ delivery_mode: 'lifekit' }), null, 'typo is not a mode');
  assertEquals(storedDeliveryMode({ delivery_mode: 42 }), null, 'not a string');
  assertEquals(storedDeliveryMode({ delivery_mode: null }), null, 'explicit null');
  // jsonb can hold an array, and `typeof [] === 'object'` would let one through
  // a laxer guard.
  assertEquals(storedDeliveryMode(['livekit']), null, 'array');
  assertEquals(storedDeliveryMode('livekit'), null, 'bare string metadata');
});

// ---------------------------------------------------------------------------
// The rates themselves
// ---------------------------------------------------------------------------
//
// EVERY OTHER TEST IN THIS FILE IS SELF-REFERENTIAL, and that turned out to
// matter. They assert things like `cost.bunnyThb === 10 * 3 *
// bunnyThbPerViewerMinute('720p')` — which compares the function against
// itself, so if PUBLISH_MBPS_BY_QUALITY were reverted to the pre-2026-09-09
// flat 3 Mbps, every single one of them would still pass. The relationships
// would all hold. Only the bill would be half.
//
// That is exactly the vintage `live-watchdog` was found running on 2026-09-14,
// a week after the ceiling doubled. So these pin the ABSOLUTE numbers: a rate
// that changes has to change here too, deliberately, in the same commit.

Deno.test('PUBLISH_MBPS_BY_QUALITY: the ladder is exactly these four rungs', () => {
  assertEquals(PUBLISH_MBPS_BY_QUALITY, { '360p': 1.6, '480p': 3, '720p': 6, '1080p': 9 });
});

Deno.test('bunnyThbPerViewerMinute: the absolute THB/viewer-minute per rung', () => {
  // (mbps × 60s ÷ 8 bits ÷ 1024) GB/min × $0.005/GB × 35 THB/USD.
  assertEquals(bunnyThbPerViewerMinute('360p'), 0.00205078125);
  assertEquals(bunnyThbPerViewerMinute('480p'), 0.00384521484375);
  assertEquals(bunnyThbPerViewerMinute('720p'), 0.0076904296875);
  assertEquals(bunnyThbPerViewerMinute('1080p'), 0.01153564453125);
});

Deno.test('bunnyThbPerViewerMinute: 720p is NOT the old flat 3 Mbps rate', () => {
  // The regression this section exists for, named outright. 3 Mbps at 720p is
  // what the 2026-09-07 vintage of live.ts charged, and it understates the CDN
  // line by exactly 2x — the 480p rate, which is why the number below is worth
  // spelling out rather than trusting the rung table alone to be right.
  const preSeptember9Rate = ((3 * 60) / 8 / 1024) * 0.005 * 35;
  assert(
    bunnyThbPerViewerMinute('720p') === preSeptember9Rate * 2,
    `720p must be 2x the old 3 Mbps rate, got ${bunnyThbPerViewerMinute('720p')}`,
  );
});

Deno.test('LIVEKIT_THB_PER_STREAM_MINUTE: the absolute per-stream-minute rate', () => {
  // $0.015 egress + 2 × $0.0005 participants, at 35 THB/USD.
  assertEquals(LIVEKIT_THB_PER_STREAM_MINUTE, 0.56);
});

Deno.test('LIVE_COST_MODEL: is a non-empty stamp', () => {
  // Not pinned to a value — bumping it is the POINT, and a test that had to be
  // edited alongside would just be edited alongside. What must not happen is it
  // becoming empty or undefined, which would write a meaningless stamp onto
  // every row and quietly make the audit trail useless.
  assert(
    typeof LIVE_COST_MODEL === 'string' && LIVE_COST_MODEL.length > 0,
    `LIVE_COST_MODEL must be a non-empty string, got ${JSON.stringify(LIVE_COST_MODEL)}`,
  );
});

// ---------------------------------------------------------------------------
// estimateLiveCost
// ---------------------------------------------------------------------------

Deno.test('estimateLiveCost: livekit_selfhost bills nothing at all', () => {
  // The regression this whole change exists to prevent. Both lines zero: the
  // droplet is a flat monthly cost, and no CDN is in the path.
  const cost = estimateLiveCost(60, 500, 'livekit_selfhost', '1080p');
  assertEquals(cost, { livekitThb: 0, bunnyThb: 0, totalThb: 0 });
});

Deno.test('estimateLiveCost: livekit_selfhost stays zero however big the audience', () => {
  // Guards against a future edit that reinstates the per-viewer line for
  // selfhost by making the audience term unconditional again.
  for (const viewers of [0, 1, 10_000]) {
    assertEquals(
      estimateLiveCost(120, viewers, 'livekit_selfhost').totalThb,
      0,
      `viewers=${viewers}`,
    );
  }
});

Deno.test('estimateLiveCost: origin zeroes the stream line but still pays the CDN', () => {
  // The distinction between the two self-hosted modes, and the reason they are
  // not collapsed into one branch: an origin viewer IS served through a Bunny
  // pull zone, so those bytes are a real bill.
  const cost = estimateLiveCost(10, 3, 'origin', '720p');
  assertEquals(cost.livekitThb, 0, 'droplet is a flat cost');
  assertEquals(cost.bunnyThb, 10 * 3 * bunnyThbPerViewerMinute('720p'));
  assert(cost.bunnyThb > 0, 'origin viewers cost CDN egress');
});

Deno.test('estimateLiveCost: the hosted pipelines pay both lines', () => {
  const cost = estimateLiveCost(10, 3, 'llhls', '720p');
  assertEquals(cost.livekitThb, 10 * LIVEKIT_THB_PER_STREAM_MINUTE);
  assertEquals(cost.bunnyThb, 10 * 3 * bunnyThbPerViewerMinute('720p'));
  assertEquals(cost.totalThb, cost.livekitThb + cost.bunnyThb);
});

Deno.test('estimateLiveCost: the audience line follows the rung', () => {
  // 1080p carries 1.5x the bytes of 720p (9 Mbps against 6), so it must cost
  // 1.5x. Pricing every session at one rung is what this replaced.
  const at720 = estimateLiveCost(10, 4, 'llhls', '720p');
  const at1080 = estimateLiveCost(10, 4, 'llhls', '1080p');
  assert(
    Math.abs(at1080.bunnyThb - at720.bunnyThb * 1.5) < 1e-9,
    `1080p should be 1.5x 720p, got ${at1080.bunnyThb} vs ${at720.bunnyThb}`,
  );
  // The stream line is per-MINUTE, not per-byte, so the rung must not move it.
  assertEquals(at1080.livekitThb, at720.livekitThb, 'rung must not change the stream line');
});

Deno.test('estimateLiveCost: an unknown rung prices as 720p', () => {
  // A row written before the rung was selectable records nothing, and must
  // price exactly as it did then rather than fall to zero.
  const unknown = estimateLiveCost(10, 4, 'llhls', 'potato' as never);
  assertEquals(unknown.bunnyThb, estimateLiveCost(10, 4, 'llhls', '720p').bunnyThb);
});

Deno.test('estimateLiveCost: defaults match the pre-selfhost call shape', () => {
  // closeLiveSession is not the only caller, and the two optional tails have to
  // keep meaning 'llhls' at 720p or older callers change price silently.
  assertEquals(estimateLiveCost(10, 3), estimateLiveCost(10, 3, 'llhls', '720p'));
});

Deno.test('estimateLiveCost: a zero-length session is free on every path', () => {
  // The watchdog can close a session whose only heartbeat predates its own
  // started_at; closeLiveSession clamps that to zero minutes, and zero minutes
  // must not produce a charge on any pipeline.
  for (const mode of ['livekit', 'llhls', 'origin', 'livekit_selfhost'] as const) {
    assertEquals(estimateLiveCost(0, 100, mode).totalThb, 0, mode);
  }
});
