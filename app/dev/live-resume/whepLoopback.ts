'use client';

/**
 * A WHEP origin, inside the page.
 *
 * WHY NOT A MOCK. The thing under test is a peer connection surviving — or not
 * surviving — a suspension, and a fetch stub that hands back a canned SDP
 * proves nothing about that: there would be no connection to close, no frames
 * to stop arriving, and `currentTime` would never advance in the first place,
 * so every health check would read as broken and every test would pass for the
 * wrong reason.
 *
 * So this is a real WHEP server: it speaks the POST/answer/DELETE the client
 * speaks, it answers with a real SDP from a real RTCPeerConnection, and what
 * comes back down the wire is a canvas being painted thirty times a second. The
 * loop closes inside one tab, which is enough — RTP over loopback is still RTP,
 * and a <video> that shows it is genuinely showing decoded frames.
 *
 * WHAT IT CAN BE TOLD TO DO, which is the other half of its job:
 *
 *   failNext(n)   refuse the next n offers with a 500, for the bounded-retry
 *                 ladder. 500 rather than 404 deliberately: 404 is structural
 *                 (see isStructuralWhepFailure) and would retire WHEP, which
 *                 is a different test.
 *   freeze()      stop painting. The track stays 'live' and stops delivering,
 *                 which is the "connected but silent" failure the watchdog
 *                 exists for and the one no connection state reports.
 *   killClient()  close the most recent CLIENT peer connection. This is the
 *                 iOS suspension, and it is faithful in the detail that
 *                 matters: the spec says close() does not fire
 *                 connectionstatechange, so nothing is notified and nothing
 *                 recovers — which is precisely why the bug was invisible.
 */

/** Every WHEP endpoint the bench uses lives under this host. */
export const BENCH_WHEP_BASE = 'https://bench.invalid/whep/live';

export interface WhepLoopback {
  /** How many offers have been POSTed. The headline assertion of most checks. */
  posts: number;
  /** How many sessions have been DELETEd. Teardown hygiene. */
  deletes: number;
  /** Refuse the next n offers with a 500 — retryable, not structural. */
  failNext(n: number): void;
  /** Stop painting: the track stays live and delivers nothing. */
  freeze(): void;
  /** Paint again. */
  thaw(): void;
  /** Close the newest client peer connection, the way a backgrounding OS does. */
  killClient(): boolean;
  /** Undo the patches and release the camera-substitute canvas. */
  dispose(): void;
}

export function installWhepLoopback(): WhepLoopback {
  const NativePc = window.RTCPeerConnection;
  const realFetch = window.fetch.bind(window);

  /**
   * The picture. A moving one, because a still canvas and a frozen decoder are
   * indistinguishable from the receiving end — which is the whole point.
   */
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d')!;
  let frame = 0;
  let painting = true;
  const paint = () => {
    if (painting) {
      frame += 1;
      ctx.fillStyle = frame % 2 ? '#0a3d62' : '#1e5f8c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = '32px monospace';
      ctx.fillText(String(frame), 20, 100);
    }
    timer = window.setTimeout(paint, 33);
  };
  let timer = window.setTimeout(paint, 33);
  const sourceStream = canvas.captureStream(30);

  /**
   * Which peer connections belong to the CLIENT.
   *
   * The bench's own server-side connections are built through the native
   * constructor directly, so anything that comes through the patched one was
   * built by the code under test. That is what makes killClient able to close
   * the right one.
   */
  const clientPcs: RTCPeerConnection[] = [];
  const serverPcs: RTCPeerConnection[] = [];

  class TrackedPc extends NativePc {
    constructor(config?: RTCConfiguration) {
      super(config);
      clientPcs.push(this as unknown as RTCPeerConnection);
    }
  }
  window.RTCPeerConnection = TrackedPc as unknown as typeof RTCPeerConnection;

  const state = { posts: 0, deletes: 0, failing: 0 };

  /** Non-trickle, like both real clients in this codebase. */
  const waitIce = (pc: RTCPeerConnection) =>
    new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => {
        if (pc.iceGatheringState !== 'complete') return;
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      };
      pc.addEventListener('icegatheringstatechange', done);
      window.setTimeout(resolve, 2_000);
    });

  const answerOffer = async (offerSdp: string): Promise<string> => {
    const pc = new NativePc({ iceServers: [] });
    serverPcs.push(pc);
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    // The transceivers come from the OFFER, so the answer's m-lines line up
    // with it by construction. Adding a track first would create a transceiver
    // of our own and put the m-lines out of order, which MediaMTX would never
    // do and the client would reject.
    for (const transceiver of pc.getTransceivers()) {
      if (transceiver.receiver.track.kind !== 'video') continue;
      await transceiver.sender.replaceTrack(sourceStream.getVideoTracks()[0]);
      transceiver.direction = 'sendonly';
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    return pc.localDescription!.sdp;
  };

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(BENCH_WHEP_BASE)) return realFetch(input as RequestInfo, init);

    if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
      state.deletes += 1;
      return new Response('', { status: 200 });
    }

    state.posts += 1;
    if (state.failing > 0) {
      state.failing -= 1;
      // A 500 is retryable by policy. 404/405/501 are not, and using one here
      // would be testing the structural path while claiming to test the ladder.
      return new Response('bench refused', { status: 500 });
    }

    const answerSdp = await answerOffer(String(init?.body ?? ''));
    return new Response(answerSdp, {
      status: 201,
      headers: {
        'Content-Type': 'application/sdp',
        Location: `${BENCH_WHEP_BASE}/session/${state.posts}`,
      },
    });
  }) as typeof window.fetch;

  return {
    get posts() {
      return state.posts;
    },
    get deletes() {
      return state.deletes;
    },
    failNext: (n) => {
      state.failing = n;
    },
    freeze: () => {
      painting = false;
    },
    thaw: () => {
      painting = true;
    },
    killClient: () => {
      const pc = clientPcs[clientPcs.length - 1];
      if (!pc) return false;
      // Per the spec this does NOT fire connectionstatechange. That is the
      // fidelity that matters: the player is left holding a dead connection
      // with nothing to tell it so, which is exactly the state an iPhone hands
      // a page back in.
      pc.close();
      return true;
    },
    dispose: () => {
      window.clearTimeout(timer);
      window.fetch = realFetch;
      window.RTCPeerConnection = NativePc;
      sourceStream.getTracks().forEach((track) => track.stop());
      serverPcs.forEach((pc) => pc.close());
    },
  };
}

/** The publisher's half. Same idea, one direction the other way. */
export const BENCH_WHIP_BASE = 'https://bench.invalid/whip/live';

export interface WhipLoopback {
  posts: number;
  dispose(): void;
}

/**
 * A WHIP ingest, inside the page.
 *
 * Answers the offer and receives; it has nothing to send back, so unlike the
 * WHEP side it needs no source. What the publisher check actually asks of it is
 * simply that there BE a live peer connection with real senders on it — a track
 * swapped into a sender that was never negotiated proves nothing.
 */
export function installWhipLoopback(): WhipLoopback {
  const NativePc = window.RTCPeerConnection;
  const realFetch = window.fetch.bind(window);
  const serverPcs: RTCPeerConnection[] = [];
  const state = { posts: 0 };

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(BENCH_WHIP_BASE)) return realFetch(input as RequestInfo, init);

    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'DELETE' || method === 'PATCH') return new Response('', { status: 200 });

    state.posts += 1;
    const pc = new NativePc({ iceServers: [] });
    serverPcs.push(pc);
    await pc.setRemoteDescription({ type: 'offer', sdp: String(init?.body ?? '') });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => {
        if (pc.iceGatheringState !== 'complete') return;
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      };
      pc.addEventListener('icegatheringstatechange', done);
      window.setTimeout(resolve, 2_000);
    });
    return new Response(pc.localDescription!.sdp, {
      status: 201,
      headers: {
        'Content-Type': 'application/sdp',
        Location: `${BENCH_WHIP_BASE}/session/${state.posts}`,
      },
    });
  }) as typeof window.fetch;

  return {
    get posts() {
      return state.posts;
    },
    dispose: () => {
      window.fetch = realFetch;
      serverPcs.forEach((pc) => pc.close());
    },
  };
}
