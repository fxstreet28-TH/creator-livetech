'use client';

/**
 * Drive the ladder by hand and watch what it does.
 *
 * The health signal is the only input the machine has, so it is the only
 * control here: 'unhealthy' starts the clock, 'paused' is the creator not
 * being on air and must freeze it, 'healthy' is the picture coming back and
 * must end the attempt and record which rung was in effect when it did.
 *
 * Every observable is mirrored into a data attribute, because the interesting
 * assertions are about a state machine over thirty-five seconds rather than
 * about pixels.
 */

import { useState } from 'react';
import {
  RECOVERY_TIMELINE,
  useRecoveryLadder,
  type PlaybackHealth,
} from '@/lib/live/useRecoveryLadder';
import { LiveRecoveryOverlay } from '@/components/live/LiveRecoveryOverlay';
import { WatchdogBench } from './WatchdogBench';

/**
 * A uuid that is not a real broadcast.
 *
 * The diagnostics RPC drops rows for sessions it cannot find, so the bench
 * exercises the whole logging path — including the network call — without
 * putting synthetic rows into a table people will read.
 */
const BENCH_SESSION_ID = '00000000-0000-4000-8000-000000000000';

export function RecoveryLadderBench() {
  const [health, setHealth] = useState<PlaybackHealth>('unhealthy');
  const ladder = useRecoveryLadder({
    sessionId: BENCH_SESSION_ID,
    delivery: 'hls',
    health,
  });

  return (
    <main style={{ padding: 24, background: '#0a0a15', color: '#eee', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 20 }}>Recovery ladder</h1>
      <p style={{ fontSize: 13, opacity: 0.7, maxWidth: 720, lineHeight: 1.6 }}>
        relay at {RECOVERY_TIMELINE.relay / 1000}s · rebuild at {RECOVERY_TIMELINE.rebuild / 1000}s ·
        reload at {RECOVERY_TIMELINE.reload / 1000}s, once per tab per broadcast, then the card.
      </p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        {(['unhealthy', 'paused', 'healthy'] as PlaybackHealth[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setHealth(value)}
            data-health-button={value}
            style={{ fontWeight: health === value ? 700 : 400, padding: '6px 12px' }}
          >
            {value}
          </button>
        ))}
      </div>

      <dl
        style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.9 }}
        data-ladder
        data-step={ladder.step}
        data-attempt-key={ladder.attemptKey}
        data-rebuild-key={ladder.rebuildKey}
        data-exhausted={String(ladder.exhausted)}
        data-seconds={ladder.secondsToNextStep ?? ''}
        data-health={health}
      >
        <div>step: {ladder.step}</div>
        <div>attemptKey: {ladder.attemptKey}</div>
        <div>rebuildKey: {ladder.rebuildKey}</div>
        <div>exhausted: {String(ladder.exhausted)}</div>
        <div>secondsToNextStep: {ladder.secondsToNextStep ?? '—'}</div>
      </dl>

      <div
        data-overlay-preview
        style={{
          position: 'relative',
          width: 360,
          height: 520,
          marginTop: 16,
          background: '#000',
          overflow: 'hidden',
        }}
      >
        <LiveRecoveryOverlay
          step={ladder.step}
          secondsToNextStep={ladder.secondsToNextStep}
          exhausted={ladder.exhausted}
          onRetry={ladder.retryNow}
          message="กำลังเชื่อมต่อวิดีโอ..."
        />
      </div>

      <WatchdogBench />
    </main>
  );
}
