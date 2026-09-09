'use client';

/**
 * The checks. See page.tsx for what this bench does and does not prove.
 *
 * HOW IT DRIVES THE REAL COMPONENT. WhepLivePlayer is mounted for real, against
 * the loopback origin, and then poked from the outside the way the operating
 * system pokes it: the peer connection is closed, the source stops painting,
 * resume events are dispatched on window and document, the overlay button is
 * clicked through the DOM. Nothing reaches inside the component — there are no
 * test hooks in it, and the assertions are made on what a viewer would see (is
 * the picture moving) and what the origin heard (how many offers arrived).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { WhepLivePlayer } from '@/components/live/WhepLivePlayer';
import { isStructuralWhepFailure } from '@/lib/live/whepClient';
import { publishWhip } from '@/lib/live/whipClient';
import { trackDeliversFrames } from '@/lib/live/dualCameraCapture';
import { useResumeTriggers } from '@/lib/live/useResumeTriggers';
import {
  BENCH_WHEP_BASE,
  BENCH_WHIP_BASE,
  installWhepLoopback,
  installWhipLoopback,
  type WhepLoopback,
} from './whepLoopback';

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until a predicate holds, or give up. Returns whether it held. */
async function until(predicate: () => boolean, timeoutMs: number, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(stepMs);
  }
}

/**
 * A resume, exactly as a returning phone delivers one: three events inside a
 * few milliseconds. Anything that answers this with more than one handshake is
 * stacking resubscribes, which is its own bug.
 */
function dispatchResumeBurst() {
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  window.dispatchEvent(new Event('focus'));
}

/** Did the picture move over this window? The only honest liveness question. */
async function framesFlow(video: HTMLVideoElement, windowMs = 900) {
  const before = video.currentTime;
  await sleep(windowMs);
  return video.currentTime > before;
}

export function ResumeBench() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState<number | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);
  const failureRef = useRef<string[]>([]);

  /**
   * The debounce claim, asserted directly rather than inferred.
   *
   * A counter driven by the real hook, so the burst dispatched in check 1 is
   * also visible here as one event and not three.
   */
  const burstCountRef = useRef(0);
  useResumeTriggers({
    onResume: useCallback(() => {
      burstCountRef.current += 1;
    }, []),
  });

  const getVideo = useCallback(
    () => hostRef.current?.querySelector('video') ?? null,
    [],
  );

  const run = useCallback(async () => {
    setRunning(true);
    const results: Check[] = [];
    const add = (name: string, pass: boolean, detail: string) => {
      results.push({ name, pass, detail });
      setChecks([...results]);
    };

    let origin: WhepLoopback | null = null;
    try {
      origin = installWhepLoopback();
      failureRef.current = [];

      // ---- 1. A closed peer connection is rebuilt on resume, once. ----------
      setMounted(1);
      let video = await waitForVideo(getVideo);
      const playing = video ? await until(() => video!.currentTime > 0, 15_000) : false;
      const postsAfterMount = origin.posts;

      if (!playing) {
        add('resubscribe_on_resume', false, 'the first WHEP handshake never produced a picture');
      } else {
        // The suspension. close() fires no event, so nothing in the player is
        // told — which is the state an iPhone hands a page back in.
        const killed = origin.killClient();
        await sleep(400);
        const quietPosts = origin.posts;

        burstCountRef.current = 0;
        dispatchResumeBurst();
        const resubscribed = await until(() => origin!.posts > quietPosts, 12_000);
        video = getVideo();
        const flowing = resubscribed && video ? await framesFlow(video) : false;
        const extraPosts = origin.posts - quietPosts;

        add(
          'resubscribe_on_resume',
          killed && quietPosts === postsAfterMount && resubscribed && flowing && extraPosts === 1,
          `killed=${killed} posts_before=${postsAfterMount} posts_while_dead=${quietPosts} ` +
            `new_posts=${extraPosts} frames_flowing=${flowing}`,
        );
        add(
          'resume_burst_is_debounced',
          burstCountRef.current === 1 && extraPosts === 1,
          `three events in one burst produced ${burstCountRef.current} resume(s) and ` +
            `${extraPosts} handshake(s)`,
        );
        add(
          'old_session_is_deleted',
          origin.deletes >= 1,
          `${origin.deletes} DELETE(s) sent for the abandoned session(s)`,
        );
      }

      // ---- 2. Connected and frozen: the watchdog rebuilds. -----------------
      setMounted(2);
      await sleep(300);
      video = await waitForVideo(getVideo);
      const started = video ? await until(() => video!.currentTime > 0, 15_000) : false;
      if (!started) {
        add('watchdog_rebuilds_a_frozen_session', false, 'the session never started');
      } else {
        const before = origin.posts;
        // The track stays 'live' and stops delivering. No connection state
        // changes; nothing but a frame check can see this.
        origin.freeze();
        const rebuilt = await until(() => origin!.posts > before, 12_000);
        origin.thaw();
        video = getVideo();
        const flowing = rebuilt && video ? await framesFlow(video, 1_200) : false;
        add(
          'watchdog_rebuilds_a_frozen_session',
          rebuilt && flowing,
          `rebuilt=${rebuilt} after a frozen track, frames_flowing=${flowing}`,
        );
      }

      // ---- 3. Three failures, then the hand-off. ---------------------------
      setMounted(3);
      await sleep(300);
      video = await waitForVideo(getVideo);
      const live = video ? await until(() => video!.currentTime > 0, 15_000) : false;
      if (!live) {
        add('bounded_retry_then_fallback', false, 'the session never started');
      } else {
        const before = origin.posts;
        failureRef.current = [];
        origin.failNext(99);
        origin.killClient();
        await sleep(300);
        dispatchResumeBurst();

        const gaveUp = await until(() => failureRef.current.length > 0, 30_000);
        const attempts = origin.posts - before;
        const reason = failureRef.current[0] ?? 'none';
        add(
          'bounded_retry_then_fallback',
          gaveUp && attempts === 3 && failureRef.current.length === 1,
          `${attempts} handshake(s) then onFailure x${failureRef.current.length} (${reason})`,
        );
        add(
          'a_retryable_failure_is_not_permanent',
          gaveUp && !isStructuralWhepFailure(reason),
          `isStructuralWhepFailure(${reason}) = ${isStructuralWhepFailure(reason)} — ` +
            'false is what lets a later resume try WHEP again',
        );

        // And the player itself holds no permanent latch: the router remounts
        // it after the cooldown and it works.
        origin.failNext(0);
        setMounted(4);
        await sleep(300);
        video = await waitForVideo(getVideo);
        const recovered = video ? await until(() => video!.currentTime > 0, 15_000) : false;
        add(
          'whep_is_tried_again_after_a_fallback',
          recovered,
          `a fresh mount against a healthy origin ${recovered ? 'played' : 'did not play'}`,
        );
      }

      add(
        'structural_failures_stay_permanent',
        ['no_webrtc', 'no_publisher', 'http_405', 'http_501', 'no_local_sdp'].every(
          isStructuralWhepFailure,
        ) && !['http_500', 'connection_failed', 'no_media'].some(isStructuralWhepFailure),
        'no_webrtc/404/405/501 retire WHEP; a 500, a dead connection and a missing picture do not',
      );

      // ---- 4. The tap on a dead session rebuilds it. -----------------------
      setMounted(5);
      await sleep(300);
      video = await waitForVideo(getVideo);
      const tapReady = video ? await until(() => video!.currentTime > 0, 15_000) : false;
      if (!tapReady) {
        add('tap_rebuilds_a_dead_session', false, 'the session never started');
      } else {
        origin.killClient();
        // What the viewer is actually looking at: a stopped element over a dead
        // session, with the overlay offering a tap.
        video!.pause();
        const button = await waitFor(
          () => hostRef.current?.querySelector<HTMLButtonElement>('button:has(> .sr-only)') ?? null,
          4_000,
        );
        const before = origin.posts;
        button?.click();
        const rebuilt = await until(() => origin!.posts > before, 12_000);
        const after = getVideo();
        const flowing = rebuilt && after ? await framesFlow(after, 1_200) : false;
        add(
          'tap_rebuilds_a_dead_session',
          !!button && rebuilt && flowing,
          `button=${!!button} new_handshake=${rebuilt} frames_flowing=${flowing} ` +
            '(the previous behaviour made zero requests)',
        );
      }

      setMounted(null);
      await sleep(200);
    } catch (err) {
      results.push({
        name: 'bench_error',
        pass: false,
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      setChecks([...results]);
    } finally {
      origin?.dispose();
    }

    // ---- 5. The publisher: a sender takes a new track, the PC is untouched.
    const whipOrigin = installWhipLoopback();
    try {
      const publisherChecks = await runPublisherCheck();
      publisherChecks.forEach((check) => add(check.name, check.pass, check.detail));
    } catch (err) {
      add(
        'whip_replace_track_keeps_the_session',
        false,
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
    } finally {
      whipOrigin.dispose();
    }

    setRunning(false);
    (window as unknown as { __resumeResult: unknown }).__resumeResult = {
      checks: results,
    };
  }, [getVideo]);

  // `?auto=1` — the headless driver's entry point. A human opening the page
  // gets a button instead.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('auto') !== '1') return;
    // On a timeout rather than inline: `run` sets state on its first line, and
    // a synchronous setState inside an effect is a cascading render (and a
    // lint error). Same shape as the dual-camera bench.
    const timer = window.setTimeout(() => void run(), 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  return (
    <main className="min-h-screen bg-neutral-950 p-6 text-sm text-white">
      <h1 className="text-lg font-semibold">live-resume bench</h1>
      <p className="mt-1 max-w-2xl text-white/50">
        Background/foreground survival for the WHEP viewer and the WHIP publisher, driven
        against a loopback origin inside this page. A phone is still the test that matters.
      </p>

      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        className="mt-4 rounded-lg bg-cyan-500 px-4 py-2 font-semibold text-black disabled:opacity-40"
      >
        {running ? 'running…' : 'run the checks'}
      </button>

      <ul className="mt-6 space-y-2">
        {checks.map((check) => (
          <li key={check.name} className="rounded-lg border border-white/10 p-3">
            <span className={check.pass ? 'text-emerald-400' : 'text-rose-400'}>
              {check.pass ? 'PASS' : 'FAIL'}
            </span>{' '}
            <span className="font-semibold">{check.name}</span>
            <p className="mt-1 text-white/50">{check.detail}</p>
          </li>
        ))}
      </ul>

      {/* Small and out of the way: what matters is that it is a real element
          decoding a real stream, not that anyone can see it. */}
      <div ref={hostRef} className="mt-6 h-[180px] w-[320px]">
        {mounted !== null && (
          <WhepLivePlayer
            key={mounted}
            whepUrl={`${BENCH_WHEP_BASE}/bench-room-${mounted}`}
            title="bench"
            elapsedSeconds={0}
            viewerCount={0}
            presentation="fullbleed"
            onFailure={(reason) => failureRef.current.push(reason)}
          />
        )}
      </div>
    </main>
  );
}

async function waitFor<T>(read: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

const waitForVideo = (get: () => HTMLVideoElement | null) => waitFor(get, 5_000);

/**
 * The publisher's mechanism, on a real WHIP session.
 *
 * WHAT IT PROVES: that a track ended by the operating system can be replaced in
 * the sender that was negotiated for it, in band, with the peer connection left
 * exactly as it was — no new session on the path, so no HLS muxer restart and
 * no viewer reconnect. That is the claim the studio's resume handler rests on.
 *
 * WHAT IT DOES NOT PROVE: that iOS ends the tracks in the first place, or that
 * `getUserMedia` hands a phone's camera back promptly. Headless Chromium ends
 * nothing on its own — the track here is ended explicitly — and Por's phone is
 * where the rest of it is decided.
 */
async function runPublisherCheck(): Promise<Check[]> {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const painter = window.setInterval(() => {
    ctx.fillStyle = `hsl(${Date.now() / 20} 60% 40%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, 33);

  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  audioContext.createOscillator().connect(destination);

  const stream = new MediaStream([
    canvas.captureStream(30).getVideoTracks()[0],
    destination.stream.getAudioTracks()[0],
  ]);

  try {
    const session = await publishWhip({
      endpoint: `${BENCH_WHIP_BASE}/bench-room`,
      stream,
      quality: '720p',
      micEnabled: true,
    });

    try {
      const pcBefore = session.pc;
      const audioSender = session.pc
        .getSenders()
        .find((sender) => sender.track?.kind === 'audio');
      const originalTrack = audioSender?.track ?? null;

      // What iOS does to a backgrounded microphone.
      originalTrack?.stop();
      const endedIsReported = originalTrack?.readyState === 'ended';
      const endedDeliversNothing = !(await trackDeliversFrames(
        stream.getVideoTracks()[0] && originalTrack ? originalTrack : undefined,
        600,
      ));

      const replacement = audioContext.createMediaStreamDestination();
      audioContext.createOscillator().connect(replacement);
      const nextTrack = replacement.stream.getAudioTracks()[0];
      const swapped = await session.replaceAudioTrack(nextTrack);

      const senderAfter = session.pc
        .getSenders()
        .find((sender) => sender.track?.kind === 'audio');

      const checks: Check[] = [
        {
          name: 'whip_replace_track_keeps_the_session',
          pass:
            swapped &&
            senderAfter?.track === nextTrack &&
            session.pc === pcBefore &&
            session.pc.connectionState !== 'closed',
          detail:
            `replaced=${swapped} sender_holds_new_track=${senderAfter?.track === nextTrack} ` +
            `same_pc=${session.pc === pcBefore} connection=${session.pc.connectionState}`,
        },
        {
          name: 'an_ended_track_is_detectable',
          pass: endedIsReported && endedDeliversNothing,
          detail:
            `readyState=${originalTrack?.readyState ?? 'gone'} ` +
            `trackDeliversFrames=${!endedDeliversNothing}`,
        },
      ];

      // The video sender takes one too, which is the canvas-track-ended path.
      const videoReplaced = await session.replaceVideoTrack(
        canvas.captureStream(30).getVideoTracks()[0],
      );
      checks.push({
        name: 'whip_video_sender_takes_a_replacement',
        pass: videoReplaced && session.pc === pcBefore,
        detail: `replaced=${videoReplaced} same_pc=${session.pc === pcBefore}`,
      });

      return checks;
    } finally {
      await session.close();
    }
  } finally {
    window.clearInterval(painter);
    stream.getTracks().forEach((track) => track.stop());
    void audioContext.close();
  }
}
