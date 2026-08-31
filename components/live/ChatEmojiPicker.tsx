'use client';

/**
 * The 😊 button on the chat input, and the emoji-mart popover behind it.
 *
 * Everything about this component is arranged around one rule: chat must work
 * whether or not emoji-mart does. So the library is imported dynamically, on
 * the first press and never before, and a failed import removes the button
 * rather than the input — the picker is a convenience, and a broadcast must
 * not be held up by ~200KB of emoji data that a CDN, a corporate proxy or a
 * flaky connection did not deliver. Lazy-loading also keeps that payload out
 * of the chat bundle for the sessions that never press it.
 *
 * emoji-mart's own React wrapper is not used (see the dependency commit): its
 * peer range stops at React 18. The core builds a custom element, which is
 * appended to a ref'd div here — the same shape as `track.attach()` in the
 * player components.
 *
 * The picker renders into a shadow root, so its internals cannot be styled
 * from globals.css. Everything configurable is passed as a prop or set as a
 * custom property on the host below.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Smile } from 'lucide-react';

/**
 * Thai UI strings for the picker.
 *
 * Passed as `i18n` rather than `locale="th"`: emoji-mart ships no th.json, and
 * an unknown locale makes it fetch
 * cdn.jsdelivr.net/npm/@emoji-mart/data@latest/i18n/th.json at runtime — a
 * request that 404s, and one this app should not be making at all (it also
 * builds as a Capacitor bundle, where a CDN call is a network dependency the
 * app is not supposed to have). A provided i18n object replaces the English
 * one outright rather than merging, so every key it reads is here.
 */
const PICKER_I18N_TH = {
  search: 'ค้นหาอิโมจิ',
  search_no_results_1: 'ไม่พบอิโมจิ',
  search_no_results_2: 'ลองคำค้นอื่นดู',
  pick: 'เลือกอิโมจิ',
  add_custom: 'เพิ่มอิโมจิ',
  categories: {
    activity: 'กิจกรรม',
    custom: 'กำหนดเอง',
    flags: 'ธง',
    foods: 'อาหารและเครื่องดื่ม',
    frequent: 'ใช้บ่อย',
    nature: 'สัตว์และธรรมชาติ',
    objects: 'สิ่งของ',
    people: 'ใบหน้าและผู้คน',
    places: 'การเดินทางและสถานที่',
    search: 'ผลการค้นหา',
    symbols: 'สัญลักษณ์',
  },
  skins: {
    choose: 'เลือกสีผิวเริ่มต้น',
    1: 'ค่าเริ่มต้น',
    2: 'อ่อน',
    3: 'ค่อนข้างอ่อน',
    4: 'กลาง',
    5: 'ค่อนข้างเข้ม',
    6: 'เข้ม',
  },
};

interface ChatEmojiPickerProps {
  /** Given the chosen emoji's native character, to insert at the caret. */
  onSelect: (native: string) => void;
  disabled?: boolean;
}

export function ChatEmojiPicker({ onSelect, disabled = false }: ChatEmojiPickerProps) {
  const [open, setOpen] = useState(false);
  /** Set once the import has failed; the button is retired rather than retried. */
  const [unavailable, setUnavailable] = useState(false);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);

  // The picker element is built once per open and holds onto whatever callback
  // it was given, so the callback it gets reads the current one from here.
  const selectRef = useRef(onSelect);
  useEffect(() => {
    selectRef.current = onSelect;
  }, [onSelect]);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let element: HTMLElement | null = null;

    async function mount() {
      let Picker: new (props: Record<string, unknown>) => unknown;
      let data: unknown;
      try {
        const [core, dataModule] = await Promise.all([
          import('emoji-mart'),
          // The data package types its shape but declares no default export,
          // while the file it resolves to is one big JSON object. The cast is
          // that mismatch, not an unknown.
          import('@emoji-mart/data').then((mod) => (mod as unknown as { default: unknown }).default),
        ]);
        Picker = core.Picker as unknown as new (props: Record<string, unknown>) => unknown;
        data = dataModule;
      } catch (err) {
        // Non-negotiable: chat keeps working. The button disappears, the input
        // does not.
        console.error('[ChatEmojiPicker] emoji-mart failed to load', err);
        if (!cancelled) {
          setUnavailable(true);
          setOpen(false);
        }
        return;
      }
      if (cancelled) return;

      element = new Picker({
        data,
        i18n: PICKER_I18N_TH,
        theme: 'dark',
        // Native OS emoji: no spritesheet to download, and Thai users see the
        // same glyphs their keyboard produces.
        set: 'native',
        previewPosition: 'none',
        skinTonePosition: 'none',
        autoFocus: true,
        perLine: 8,
        maxFrequentRows: 1,
        onEmojiSelect: (emoji: { native?: string }) => {
          if (typeof emoji?.native === 'string') selectRef.current(emoji.native);
          setOpen(false);
          buttonRef.current?.focus();
        },
      }) as HTMLElement;

      // The 400px cap is the popover's, not the picker's default 435px, and
      // the font is inherited so Thai category labels use the app's face
      // rather than the picker's system stack.
      element.style.height = '400px';
      element.style.maxWidth = '100%';
      element.style.setProperty('--font-family', 'inherit');
      element.style.setProperty('--rgb-background', '12, 16, 27');
      mountRef.current?.replaceChildren(element);
    }

    void mount();

    return () => {
      cancelled = true;
      element?.remove();
    };
  }, [open]);

  // Escape and outside-click. Both are on the document because the picker's
  // own contents live in a shadow root — events from inside it retarget to the
  // host element, which is inside popoverRef, so contains() still answers
  // correctly.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  if (unavailable) return null;

  return (
    <div className="relative shrink-0">
      {open && (
        <div
          ref={popoverRef}
          // Anchored to the button's top-left and sitting above it. z-40 is
          // over the chat panel and under the z-50 dialogs (EndLiveConfirm),
          // which must never be covered by a picker.
          className="absolute bottom-full left-0 z-40 mb-2 overflow-hidden rounded-2xl border border-white/10 bg-[#0c101b] shadow-2xl shadow-black/60"
        >
          <div ref={mountRef} className="max-h-[400px] min-h-[230px] w-[352px] max-w-[80vw]" />
        </div>
      )}

      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={open ? 'ปิดตัวเลือกอิโมจิ' : 'เลือกอิโมจิ'}
        onClick={() => setOpen((current) => !current)}
        className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40 ${
          open
            ? 'border-transparent bg-gradient-to-br from-purple-500/30 to-cyan-500/20 text-white'
            : 'border-white/10 bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white'
        }`}
      >
        <Smile size={18} aria-hidden />
      </button>
    </div>
  );
}
