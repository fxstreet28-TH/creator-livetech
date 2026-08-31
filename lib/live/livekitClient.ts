'use client';

/**
 * The thin layer between this app and `livekit-client`.
 *
 * Everything the SDK is used for lives here — room construction, connecting as
 * publisher or subscriber, the chat data channel, device enumeration, and the
 * Thai text for every way those can fail — so the components stay React and
 * the SDK stays in one file. That is the same split as lib/creator/uploader.ts,
 * which owns the XHR the upload screen does not want to know about.
 *
 * `@livekit/components-react` is deliberately NOT a dependency. Its prebuilt
 * conference UI is a different product from the two bespoke layouts this
 * sprint needs, it ships its own stylesheet that would fight the aurora theme,
 * and it declares `@livekit/krisp-noise-filter` as a peer — three costs for a
 * `<VideoTrack>` that is eleven lines of `track.attach()` here. Raw
 * `livekit-client` is explicitly allowed by the brief.
 */

import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteTrack,
} from 'livekit-client';
import type { BroadcastQuality, LiveChatMessage } from './types';
import { MAX_CHAT_LENGTH, qualityOption } from './constants';
import { REACTION_TOPIC, encodeReaction } from './reactions';

export { ConnectionState, DisconnectReason, Room, RoomEvent, Track };
export type { RemoteTrack };

/** The data-channel topic chat travels on. Reactions share the room on their own. */
const CHAT_TOPIC = 'chat';

/**
 * Capture resolution for a quality choice.
 *
 * Built from the height rather than picked out of `VideoPresets` because that
 * set is 16:9 but has no 480p entry (only `VideoPresets43` does, at 4:3), and
 * a broadcast that silently switches aspect ratio between two adjacent quality
 * options is worse than one explicit calculation. Width is rounded to an even
 * number — some encoders reject odd dimensions.
 */
export function resolutionFor(quality: BroadcastQuality): {
  width: number;
  height: number;
  frameRate: number;
} {
  const { height } = qualityOption(quality);
  const width = Math.round((height * 16) / 9 / 2) * 2;
  // 30fps at every rung: the tier caps resolution, not smoothness, and 15fps
  // on the low tiers would read as a broken stream rather than a cheap one.
  return { width, height, frameRate: 30 };
}

/**
 * A room configured for one-to-many broadcast.
 *
 * `adaptiveStream` lets a viewer's client drop to a lower simulcast layer when
 * its video element is small or hidden; `dynacast` stops the broadcaster
 * uploading layers nobody is watching. Both matter more here than in a
 * meeting: the platform pays LiveKit per participant-minute, and the budget
 * kill switch in `check_creator_can_golive` is what turns that bill into a
 * refusal to go live at all.
 */
export function createRoom(quality?: BroadcastQuality): Room {
  return new Room({
    adaptiveStream: true,
    dynacast: true,
    ...(quality ? { videoCaptureDefaults: { resolution: resolutionFor(quality) } } : {}),
  });
}

export interface PublisherOptions {
  wsUrl: string;
  token: string;
  quality: BroadcastQuality;
  /** From the camera picker. Undefined means "whatever the browser prefers". */
  videoDeviceId?: string;
  /** Start with the mic muted — the toggle on the setup screen. */
  micEnabled?: boolean;
}

/**
 * Connect and start publishing camera + mic.
 *
 * Camera and mic are enabled in sequence rather than in parallel: Safari
 * rejects overlapping getUserMedia calls, and a creator who has just granted
 * permission would see the second one fail for no visible reason.
 */
export async function connectAsPublisher(room: Room, options: PublisherOptions): Promise<void> {
  await room.connect(options.wsUrl, options.token);
  await room.localParticipant.setCameraEnabled(true, {
    resolution: resolutionFor(options.quality),
    ...(options.videoDeviceId ? { deviceId: { exact: options.videoDeviceId } } : {}),
  });
  await room.localParticipant.setMicrophoneEnabled(options.micEnabled ?? true);
}

/** Connect as a viewer. The token carries canPublish: false, so nothing is captured. */
export async function connectAsSubscriber(
  room: Room,
  wsUrl: string,
  token: string,
): Promise<void> {
  await room.connect(wsUrl, token);
}

/**
 * How many people are watching.
 *
 * `remoteParticipants` excludes the local participant, so on the broadcaster's
 * screen this is exactly the audience. A viewer counts themselves back in —
 * see viewerCountForViewer.
 */
export function audienceCount(room: Room | null): number {
  return room?.remoteParticipants.size ?? 0;
}

/**
 * The number a viewer should see: everyone else in the room, plus themselves,
 * minus the broadcaster — who is a participant but not a viewer.
 */
export function viewerCountForViewer(room: Room | null): number {
  if (!room) return 0;
  let broadcasters = 0;
  for (const participant of room.remoteParticipants.values()) {
    if (isCreatorIdentity(participant.identity)) broadcasters += 1;
  }
  return Math.max(0, room.remoteParticipants.size - broadcasters + 1);
}

/**
 * Whether a participant is the room's broadcaster.
 *
 * The backend mints identities as `creator-<creators.id>` for the publisher
 * and `viewer-<auth.users.id>` for everyone else, and LiveKit — not the
 * client — is what asserts them. So this is a trustworthy check, unlike the
 * `sender` name carried inside a chat payload, which is whatever the sender
 * typed.
 */
export function isCreatorIdentity(identity: string | null | undefined): boolean {
  return typeof identity === 'string' && identity.startsWith('creator-');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Send one chat line to everyone in the room. Reliable: a dropped line is a bug. */
export async function publishChat(room: Room, text: string, sender: string): Promise<void> {
  const payload: LiveChatMessage = {
    type: 'chat',
    text: text.slice(0, MAX_CHAT_LENGTH),
    sender,
    timestamp: Date.now(),
  };
  await room.localParticipant.publishData(encoder.encode(JSON.stringify(payload)), {
    reliable: true,
    topic: CHAT_TOPIC,
  });
}

/**
 * Read a data packet as a chat line, or null if it is not one.
 *
 * Every field is re-validated and re-truncated rather than trusted: a data
 * packet is arbitrary bytes from another participant, and this app is not the
 * only thing that can be connected to a LiveKit room. Nothing here is rendered
 * as HTML — React escapes it — but an unbounded string would still let one
 * viewer push everyone else's panel off the screen.
 */
export function decodeChat(payload: Uint8Array): LiveChatMessage | null {
  try {
    const parsed = JSON.parse(decoder.decode(payload)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const message = parsed as Partial<LiveChatMessage>;
    if (message.type !== 'chat' || typeof message.text !== 'string') return null;

    const text = message.text.slice(0, MAX_CHAT_LENGTH).trim();
    if (text === '') return null;

    return {
      type: 'chat',
      text,
      sender:
        typeof message.sender === 'string' && message.sender.trim() !== ''
          ? message.sender.slice(0, 40)
          : 'ผู้ชม',
      timestamp:
        typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
          ? message.timestamp
          : Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Send one emoji reaction to everyone in the room.
 *
 * Reliable, like chat: an unreliable channel would drop exactly the packets a
 * burst of tapping produces, and a heart that never arrives is the whole
 * feature failing quietly. The packet is built in ./reactions — this is only
 * the handoff to the SDK.
 *
 * The caller is expected to have passed its throttle first
 * (createReactionThrottle); nothing here rate-limits.
 */
export async function publishReaction(room: Room, emoji: string): Promise<void> {
  const payload = encodeReaction(emoji, room.localParticipant.identity ?? '');
  await room.localParticipant.publishData(payload, {
    reliable: true,
    topic: REACTION_TOPIC,
  });
}

/** Cameras the browser will admit to, for the picker. Empty before permission is granted. */
export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  try {
    return await Room.getLocalDevices('videoinput', false);
  } catch (err) {
    console.error('[live/livekit] enumerate video inputs failed', err);
    return [];
  }
}

/** Stop every local track and leave the room. Safe to call twice. */
export async function leaveRoom(room: Room | null): Promise<void> {
  if (!room) return;
  try {
    await room.disconnect();
  } catch (err) {
    console.error('[live/livekit] disconnect failed', err);
  }
}

/** The publication of a local track kind, for level metering and mute state. */
export function localPublication(
  room: Room | null,
  source: Track.Source,
): LocalTrackPublication | undefined {
  return room?.localParticipant.getTrackPublication(source);
}

const MEDIA_ERROR_NAMES = new Set([
  'NotAllowedError',
  'SecurityError',
  'NotFoundError',
  'DevicesNotFoundError',
  'NotReadableError',
  'TrackStartError',
  'OverconstrainedError',
]);

/**
 * Thai for a getUserMedia failure.
 *
 * The DOMException names are the contract here, not the messages, which differ
 * per browser and are in English. `NotAllowedError` is by far the common one
 * and is the only one a creator can act on, so it gets the instruction.
 */
export function thaiForMediaError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'เบราว์เซอร์ปฏิเสธการเข้าถึงกล้องหรือไมโครโฟน กรุณาอนุญาตในการตั้งค่าเบราว์เซอร์แล้วลองใหม่';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'ไม่พบกล้องหรือไมโครโฟนบนอุปกรณ์นี้';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'กล้องถูกใช้งานโดยแอปอื่นอยู่ กรุณาปิดแอปนั้นแล้วลองใหม่';
    case 'OverconstrainedError':
      return 'กล้องนี้ไม่รองรับความละเอียดที่เลือก กรุณาเลือกคุณภาพต่ำลง';
    default:
      return 'เปิดกล้องไม่สำเร็จ กรุณาลองใหม่';
  }
}

/**
 * Thai for a failure to connect or publish to LiveKit.
 *
 * A media failure is passed through to thaiForMediaError: connectAsPublisher
 * does both jobs, and "อนุญาตกล้อง" is a very different instruction from
 * "ตรวจสอบอินเทอร์เน็ต".
 */
export function thaiForConnectError(err: unknown): string {
  if (err instanceof Error && MEDIA_ERROR_NAMES.has(err.name)) {
    return thaiForMediaError(err);
  }
  const text = err instanceof Error ? err.message.toLowerCase() : '';
  if (text.includes('token') || text.includes('permission') || text.includes('unauthorized')) {
    return 'สิทธิ์เข้าห้องไลฟ์หมดอายุ กรุณาเริ่มไลฟ์ใหม่อีกครั้ง';
  }
  return 'เชื่อมต่อเซิร์ฟเวอร์ไลฟ์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
}
