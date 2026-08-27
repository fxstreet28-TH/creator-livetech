/**
 * Unit tests for the pure parts of the Week 3 money path — the arithmetic
 * that decides what a buyer is charged, and the parsing that decides who
 * gets credited. Both run on every purchase and neither needs a database,
 * a Stripe key, or a deployed function to be wrong.
 *
 *   deno task test
 */

import { priceInSatang } from './stars.ts';
import { latestChargeId, parseStarMetadata } from './stripe.ts';

/**
 * Structural equality, by value. Deliberately not std/assert: this file is
 * the whole test suite, and a remote import would make running it depend on
 * a registry being reachable.
 */
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual) ?? 'undefined';
  const b = JSON.stringify(expected) ?? 'undefined';
  if (a !== b) throw new Error(`${msg ?? 'not equal'}\n  actual:   ${a}\n  expected: ${b}`);
}

Deno.test('priceInSatang: launch price', () => {
  assertEquals(priceInSatang(10, 11.0), { amountSatang: 11000, amountThb: 110 });
  assertEquals(priceInSatang(500, 11.0), { amountSatang: 550000, amountThb: 5500 });
});

Deno.test('priceInSatang: a price with satang in it stays exact', () => {
  // A promo price is the case where floating point could bite: 11.1 has no
  // exact binary representation, so the result must not depend on a
  // rounding step to come out whole.
  assertEquals(priceInSatang(500, 11.1), { amountSatang: 555000, amountThb: 5550 });
  assertEquals(priceInSatang(3, 11.1), { amountSatang: 3330, amountThb: 33.3 });
  assertEquals(priceInSatang(7, 10.05), { amountSatang: 7035, amountThb: 70.35 });
});

Deno.test('priceInSatang: bounds of the purchase range', () => {
  assertEquals(priceInSatang(10, 20.0).amountSatang, 20000);
  assertEquals(priceInSatang(100_000, 11.0).amountSatang, 110_000_000);
});

const USER = '11111111-2222-3333-4444-555555555555';

Deno.test('parseStarMetadata: a PaymentIntent we created', () => {
  assertEquals(
    parseStarMetadata({
      user_id: USER,
      stars: '500',
      retail_thb_per_star: '11',
      internal_thb_per_star: '10',
      pricing_config_id: 'cfg-1',
      source: 'preset',
    }),
    {
      user_id: USER,
      stars: 500,
      retail_thb_per_star: 11,
      internal_thb_per_star: 10,
      pricing_config_id: 'cfg-1',
      source: 'preset',
    },
  );
});

Deno.test('parseStarMetadata: anything not ours is null, never a partial credit', () => {
  // `stripe trigger payment_intent.succeeded` sends exactly this.
  assertEquals(parseStarMetadata({}), null);
  assertEquals(parseStarMetadata(null), null);
  assertEquals(parseStarMetadata(undefined), null);
  // A charge from some other product on the same account.
  assertEquals(parseStarMetadata({ order_id: 'x' }), null);
  // Present but unusable: a NaN here would credit nobody a NaN of stars.
  assertEquals(parseStarMetadata({ user_id: USER }), null);
  assertEquals(parseStarMetadata({ user_id: USER, stars: 'lots' }), null);
  assertEquals(parseStarMetadata({ user_id: USER, stars: '10.5' }), null);
  assertEquals(parseStarMetadata({ user_id: USER, stars: '0' }), null);
  assertEquals(parseStarMetadata({ user_id: USER, stars: '-5' }), null);
  assertEquals(parseStarMetadata({ user_id: '', stars: '10' }), null);
});

Deno.test('parseStarMetadata: optional fields default rather than reject', () => {
  const parsed = parseStarMetadata({ user_id: USER, stars: '10' });
  assertEquals(parsed?.stars, 10);
  assertEquals(parsed?.pricing_config_id, null);
  assertEquals(parsed?.source, 'custom');
  assertEquals(parsed?.retail_thb_per_star, 0);
});

Deno.test('latestChargeId: expanded or not', () => {
  assertEquals(latestChargeId({ latest_charge: 'ch_1' } as never), 'ch_1');
  assertEquals(latestChargeId({ latest_charge: { id: 'ch_2' } } as never), 'ch_2');
  assertEquals(latestChargeId({ latest_charge: null } as never), null);
  assertEquals(latestChargeId({} as never), null);
});
