'use client';

/**
 * Which network path a WebRTC viewer actually got, small enough to fit in a
 * diagnostics row.
 *
 * WHY THIS EXISTS AT ALL, given the server has logs of its own.
 *
 * The 2026-09-10 self-host bring-up produced a failure nobody could pin down
 * from either end: an iPhone viewer would play for a few seconds and then drop
 * with PEER_CONNECTION_DISCONNECTED. The server-side suspicion was that LiveKit
 * was advertising all four of the droplet's host IPs — the public one plus
 * DigitalOcean's anchor address, the VPC address and Docker's bridge — three of
 * which are unroutable from a phone. But the only evidence for that lived in a
 * `docker compose logs` line on a box reachable over SSH, which is exactly the
 * thing you cannot read while holding the phone that is failing.
 *
 * `remoteCandidates` below is that same fact, observed from the viewer. If a
 * phone reports having been offered 10.104.0.3 then the server is still
 * advertising private addresses, whatever the config file says; if it reports
 * one address and that address is the public one, the candidate list is fixed
 * and a disconnect after that is a different bug. Neither answer needs a shell.
 *
 * WHAT IS DELIBERATELY NOT RECORDED: the viewer's own address.
 *
 * `viewerDiagnostics` promises rows that carry "no viewer identity beyond the
 * user id the database takes from the session itself", and a local candidate
 * address would break that promise — a host candidate is the phone's LAN
 * address and a server-reflexive one is the household's public IP. So the LOCAL
 * side contributes its TYPE only ('host' / 'srflx' / 'relay'), which is what
 * says whether the recovery ladder's relay rung took effect, and nothing that
 * identifies where the viewer is. The REMOTE side is recorded in full: those
 * addresses are our own server's, and they are the whole point.
 */

/**
 * A source of stats. Structural rather than the SDK's type on purpose: this is
 * satisfied by livekit-client's RemoteTrack, and by anything else that can hand
 * over a stats report, without this module importing the SDK — which keeps it
 * usable from the WHEP path, where there is no LiveKit Room at all, only a bare
 * RTCPeerConnection.
 */
export interface RtcStatsSource {
  getRTCStatsReport?: () => Promise<RTCStatsReport | undefined>;
}

/** How many distinct server addresses to keep. See summariseIcePath. */
const MAX_REMOTE_CANDIDATES = 8;

export interface IcePathSnapshot {
  /**
   * The nominated LOCAL candidate's type, never its address — see the header.
   * 'relay' here is the proof that the ladder's relay rung did what it claims.
   */
  localType?: string;
  /** The nominated REMOTE candidate's type, as the server offered it. */
  remoteType?: string;
  /** The address media is actually flowing to. Our server, so recorded whole. */
  remoteAddress?: string;
  remotePort?: number;
  /** 'udp' or 'tcp' — tcp means the 7881 fallback carried it, which is slow. */
  protocol?: string;
  /** Round trip on the nominated pair, in whole milliseconds. */
  rttMs?: number;
  /**
   * How many pairs the browser had on the go.
   *
   * A high number against a single useful server address is the signature of
   * the candidate-list bug: the browser is burning its checking budget on
   * addresses that will never answer.
   */
  pairsTried?: number;
  /**
   * EVERY distinct address the server offered, deduplicated.
   *
   * The field this module was written for. Four entries here means the
   * `rtc.ips.includes` filter is not in effect on the server.
   */
  remoteCandidates?: string[];
  /** Bytes in on the nominated pair — zero on a pair that never carried media. */
  bytesReceived?: number;
}

type StatEntry = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reduce a full stats report to the handful of fields above.
 *
 * Exported for the tests and for the WHEP path; most callers want `readIcePath`.
 *
 * THE SELECTED PAIR IS LOOKED UP THREE WAYS, because no one way works
 * everywhere. `transport.selectedCandidatePairId` is the correct answer and is
 * what Chrome gives; Safari has historically not populated it, so a nominated
 * succeeded pair is the fallback, and any succeeded pair the last resort. A
 * snapshot with no selected pair is still worth returning — `remoteCandidates`
 * is populated either way, and a viewer who never nominated anything is
 * precisely the case being investigated.
 */
export function summariseIcePath(report: RTCStatsReport): IcePathSnapshot {
  const locals = new Map<string, StatEntry>();
  const remotes = new Map<string, StatEntry>();
  const pairs: StatEntry[] = [];
  let selectedPairId: string | undefined;

  report.forEach((raw) => {
    const stat = raw as StatEntry;
    switch (str(stat.type)) {
      case 'local-candidate':
        if (str(stat.id)) locals.set(stat.id as string, stat);
        break;
      case 'remote-candidate':
        if (str(stat.id)) remotes.set(stat.id as string, stat);
        break;
      case 'candidate-pair':
        pairs.push(stat);
        break;
      case 'transport':
        selectedPairId = str(stat.selectedCandidatePairId) ?? selectedPairId;
        break;
      default:
        break;
    }
  });

  const selected =
    (selectedPairId ? pairs.find((pair) => str(pair.id) === selectedPairId) : undefined) ??
    pairs.find((pair) => pair.nominated === true && str(pair.state) === 'succeeded') ??
    pairs.find((pair) => str(pair.state) === 'succeeded');

  const localId = selected ? str(selected.localCandidateId) : undefined;
  const remoteId = selected ? str(selected.remoteCandidateId) : undefined;
  const local = localId ? locals.get(localId) : undefined;
  const remote = remoteId ? remotes.get(remoteId) : undefined;

  // `address` is the standard field; `ip` is the pre-standard name Safari still
  // emits on some versions. Reading both costs nothing and losing the address on
  // exactly the browser this was written for would be the whole value gone.
  const offered = Array.from(remotes.values())
    .map((candidate) => str(candidate.address) ?? str(candidate.ip))
    .filter((address): address is string => address !== undefined);

  const rttSeconds = selected ? num(selected.currentRoundTripTime) : undefined;

  return {
    localType: local ? str(local.candidateType) : undefined,
    remoteType: remote ? str(remote.candidateType) : undefined,
    remoteAddress: remote ? (str(remote.address) ?? str(remote.ip)) : undefined,
    remotePort: remote ? num(remote.port) : undefined,
    protocol: (selected ? str(selected.protocol) : undefined) ?? (remote ? str(remote.protocol) : undefined),
    rttMs: rttSeconds === undefined ? undefined : Math.round(rttSeconds * 1000),
    pairsTried: pairs.length,
    // Deduplicated, then capped: a server behaving correctly offers one address
    // and a misconfigured one offers four, so anything past the cap is a
    // pathology the first eight already evidence.
    remoteCandidates: Array.from(new Set(offered)).slice(0, MAX_REMOTE_CANDIDATES),
    bytesReceived: selected ? num(selected.bytesReceived) : undefined,
  };
}

/**
 * The snapshot, or null if it could not be taken.
 *
 * NEVER THROWS and never rejects, for the same reason every call in
 * `viewerDiagnostics` is fire-and-forget: this runs on the failure path of the
 * screen a viewer is watching, and instrumentation that can break the thing it
 * measures is worse than no instrumentation. A null here costs one empty column
 * on one diagnostic row.
 *
 * `getRTCStatsReport` is probed rather than assumed: it is livekit-client's
 * own accessor and the SDK is a dependency that moves, so a rename upstream
 * degrades this to a missing field instead of an exception on a viewer's phone.
 */
export async function readIcePath(
  source: RtcStatsSource | null | undefined,
): Promise<IcePathSnapshot | null> {
  try {
    if (typeof source?.getRTCStatsReport !== 'function') return null;
    const report = await source.getRTCStatsReport();
    if (!report) return null;
    return summariseIcePath(report);
  } catch {
    return null;
  }
}
