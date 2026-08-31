'use client';

/**
 * Edit a post's title, description and access level.
 *
 * The video file itself is not editable — swapping it would mean a new Bunny
 * video and a new draft row, which is what /creator/upload already is.
 *
 * Writes straight to feed_posts with the browser client: the
 * `feed_posts_creator_own_all` policy is FOR ALL with a WITH CHECK, so the
 * database refuses an update to a row that is not this creator's, and an Edge
 * Function in front of a three-column update would only add a hop.
 *
 * Dialog shell (overlay, focus trap, three ways out) follows FeedbackModal —
 * this repo has no shared modal primitive and the brief is explicit about not
 * introducing one.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import type { CreatorPost, CreatorVisibility } from '@/lib/creator/types';
import { CREATOR_PPV_ENABLED } from '@/lib/features';
import {
  PostMetadataForm,
  validateMetadata,
  type PostMetadata,
} from './PostMetadataForm';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface PostEditModalProps {
  post: CreatorPost;
  onClose: () => void;
  /** Called after the row is updated, so the page can re-read it. */
  onSaved: () => void;
}

/**
 * An access_level this form cannot set ('free_preview') falls back to the
 * conservative option rather than being silently preserved — the toggle would
 * otherwise show nothing selected and the first save would look like a change
 * the creator did not make.
 */
function toVisibility(accessLevel: string): CreatorVisibility {
  if (accessLevel === 'public' || accessLevel === 'ppv') return accessLevel;
  return 'subscribers';
}

export function PostEditModal({ post, onClose, onSaved }: PostEditModalProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();
  const slideIn = reduceMotion ? 0 : 12;
  const slideOut = reduceMotion ? 0 : 8;

  const [metadata, setMetadata] = useState<PostMetadata>({
    title: post.title ?? '',
    description: post.content ?? '',
    visibility: toVisibility(post.access_level),
    // No column holds this yet, so an existing post has no price to load.
    ppvPrice: '',
  });
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = validateMetadata(metadata);
  const valid = Object.keys(errors).length === 0;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const card = cardRef.current;
      if (!card) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !card.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, []);

  const handleOverlayClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) onClose();
    },
    [onClose],
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    setShowErrors(true);
    if (!valid) return;

    setError(null);
    setSaving(true);

    let supabase;
    try {
      supabase = getBrowserSupabase();
    } catch {
      setError('ระบบยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง');
      setSaving(false);
      return;
    }

    const description = metadata.description.trim();
    const { error: updateError } = await supabase
      .from('feed_posts')
      .update({
        title: metadata.title.trim(),
        // `content` is the description column; an emptied field becomes NULL
        // rather than '' so it reads the same as a post that never had one.
        content: description === '' ? null : description,
        // ppv_price_stars is deliberately absent: no such column exists, and
        // PPV stays behind CREATOR_PPV_ENABLED until the backend can store a
        // price on ppv_posts.
        access_level: CREATOR_PPV_ENABLED ? metadata.visibility : toVisibilityWithoutPpv(metadata.visibility),
      })
      .eq('id', post.id);

    setSaving(false);

    if (updateError) {
      console.error('[PostEditModal] feed_posts update failed', updateError);
      setError('บันทึกไม่สำเร็จ กรุณาลองใหม่');
      return;
    }

    onSaved();
    onClose();
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/65 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] pt-[calc(1rem+env(safe-area-inset-top))]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={handleOverlayClick}
      role="presentation"
    >
      <motion.div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, y: slideIn }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: slideOut }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="relative my-auto w-full max-w-[30rem] rounded-2xl border border-white/10 bg-[#120f22] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.6)] sm:p-6"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="ปิด"
          className="absolute right-2 top-2 grid h-11 w-11 place-items-center rounded-xl text-white/50 transition hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          <X size={18} aria-hidden />
        </button>

        <h2 id={titleId} className="pr-10 text-lg font-bold text-white">
          แก้ไขโพสต์
        </h2>
        <p className="mt-1 text-xs text-white/45">เปลี่ยนไฟล์วิดีโอไม่ได้ — ต้องอัปโหลดใหม่</p>

        <form onSubmit={handleSubmit} noValidate className="mt-5">
          <PostMetadataForm
            value={metadata}
            onChange={setMetadata}
            errors={showErrors ? errors : {}}
            disabled={saving}
            footer={
              <>
                {error && (
                  <p
                    role="alert"
                    className="rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
                  >
                    {error}
                  </p>
                )}
                <div className="flex flex-col gap-3 sm:flex-row-reverse">
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-bold text-white transition hover:shadow-lg hover:shadow-purple-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
                  >
                    {saving && <Loader2 size={15} className="animate-spin" aria-hidden />}
                    บันทึก
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={saving}
                    className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
                  >
                    ยกเลิก
                  </button>
                </div>
              </>
            }
          />
        </form>
      </motion.div>
    </motion.div>
  );
}

/** Belt and braces: PPV must not reach the database while the flag is off. */
function toVisibilityWithoutPpv(visibility: CreatorVisibility): CreatorVisibility {
  return visibility === 'ppv' ? 'subscribers' : visibility;
}
