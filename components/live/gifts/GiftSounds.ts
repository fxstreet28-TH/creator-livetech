'use client';

/**
 * The gift chime, synthesised rather than fetched.
 *
 * MUTED BY DEFAULT, ALWAYS.
 *
 * A viewer opens a live stream expecting the creator's audio and nothing else.
 * A page that starts making its own noise is a page people close, and on mobile
 * it competes with the broadcast itself. Sound is opt-in, the preference is
 * remembered, and the preference lives on the creator's screen because the
 * creator is the one who wants to hear that a gift landed while they are
 * looking at their camera rather than at the overlay.
 *
 * WHY WEB AUDIO AND NOT AN MP3
 *
 * Four tiers would be four more files in `public/`, four more requests during a
 * broadcast, and a licensing question for each. Three oscillators and a gain
 * ramp are a few dozen bytes of code, and the pitch can be derived from the
 * tier — so an expensive gift sounds bigger than a cheap one for free, and a
 * tier added to the database tomorrow already has a sound.
 *
 * AUTOPLAY POLICY
 *
 * A browser will not let an AudioContext make a sound until the user has
 * interacted with the page, and creating one before that leaves it 'suspended'
 * forever in some engines. So the context is created LAZILY, on the first
 * unmute — which is a click, which is the interaction. `resume()` is still
 * attempted on every play for the tab that was backgrounded in between.
 */

/** localStorage key. Shared with the creator's mute toggle. */
export const GIFT_SOUND_STORAGE_KEY = 'aurum.live.giftSound';

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context) return context;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
    return context;
  } catch {
    // A browser that refuses to construct one at all (a locked-down WebView).
    // Silence is a perfectly acceptable outcome for a decorative chime.
    return null;
  }
}

/**
 * Read the saved preference. Defaults to MUTED.
 *
 * Wrapped because `localStorage` throws rather than returning null in a Safari
 * private window, and a thrown getter in a render path would take the whole
 * overlay down over a sound setting.
 */
export function readGiftSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(GIFT_SOUND_STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

function writeGiftSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(GIFT_SOUND_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Storage is full or blocked. The preference simply does not persist.
  }
}

/**
 * The preference as an EXTERNAL STORE, for `useSyncExternalStore`.
 *
 * localStorage does not exist on the server, so a hook cannot read it during
 * render, and reading it in an effect to call setState is the cascading-render
 * pattern React's own lint rule objects to. `useSyncExternalStore` is the
 * answer React provides for exactly this: a value that lives outside React,
 * with a server snapshot of "muted" that matches what the markup says.
 *
 * Subscribing to `storage` is a small bonus rather than the point: a creator
 * who mutes gifts in one tab has muted them in the other.
 */
const listeners = new Set<() => void>();

export function subscribeGiftSound(onChange: () => void): () => void {
  listeners.add(onChange);
  if (typeof window !== 'undefined') window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onChange);
  };
}

/** Safe to call repeatedly: it returns a primitive, so React compares by value. */
export const getGiftSoundSnapshot = readGiftSoundEnabled;

/** The server always renders the muted state, which is also the default. */
export const getGiftSoundServerSnapshot = () => false;

export function setGiftSoundEnabled(enabled: boolean): void {
  writeGiftSoundEnabled(enabled);
  for (const listener of listeners) listener();
}

/**
 * The notes a tier's chime is built from.
 *
 * A rising major arpeggio, transposed down as the tier gets more expensive, so
 * a Nova arrives lower and fuller than a Stardust rather than just louder. The
 * cheapest gift is the shortest and quietest — it is the one that arrives ten
 * times in a row.
 */
function chimeFor(starsTotal: number): { notes: number[]; gain: number; length: number } {
  if (starsTotal >= 1000) return { notes: [196.0, 261.63, 392.0, 523.25], gain: 0.16, length: 1.2 };
  if (starsTotal >= 100) return { notes: [261.63, 329.63, 392.0, 523.25], gain: 0.14, length: 0.95 };
  if (starsTotal >= 20) return { notes: [329.63, 415.3, 523.25], gain: 0.12, length: 0.7 };
  if (starsTotal >= 5) return { notes: [392.0, 523.25], gain: 0.1, length: 0.5 };
  return { notes: [523.25], gain: 0.08, length: 0.32 };
}

/**
 * Play a gift's chime. A no-op when muted, or when the browser has no audio.
 *
 * Never throws and never awaits: this is called from the same handler that
 * enqueues the animation, and a rejected `resume()` on a backgrounded tab must
 * not stop the gift from being drawn.
 */
export function playGiftSound(starsTotal: number, enabled: boolean): void {
  if (!enabled) return;

  const ctx = audioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }

  const { notes, gain, length } = chimeFor(starsTotal);
  const now = ctx.currentTime;

  notes.forEach((frequency, index) => {
    const start = now + index * (length / (notes.length + 1));
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();

    // Triangle rather than sine: it has enough harmonic content to be audible
    // over a voice without the buzz of a sawtooth.
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, start);

    // A ramp, not a step. A gain that jumps to full produces a click at the
    // start of every note, which over ten combo gifts is the whole sound.
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(gain, start + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + length);

    oscillator.connect(envelope);
    envelope.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + length + 0.05);
  });
}
