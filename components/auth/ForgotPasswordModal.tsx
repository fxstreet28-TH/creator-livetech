'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { isValidEmail } from '@/lib/validation';
import { CheckIcon, CloseIcon, MailIcon, Spinner } from './AuthIcons';

type Status = 'idle' | 'sending' | 'sent' | 'error';

type Props = { open: boolean; onClose: () => void };

/** Seconds the resend button stays locked after a successful send. */
const COOLDOWN_SECONDS = 60;

/**
 * "ลืมรหัสผ่าน?" modal. Collects an email and asks Supabase Auth to mail a
 * recovery link pointing back at /reset-password on this same origin.
 *
 * The cooldown here is UX only — it stops an impatient user hammering the
 * button and being told "too many requests". The real throttle is Supabase's
 * server-side rate limit on resetPasswordForEmail; do not add a custom limiter
 * on top of it.
 *
 * The result is deliberately not distinguished by whether the address has an
 * account: showing "no such user" would turn this modal into an account
 * enumeration oracle. Supabase reports success either way, and so do we.
 *
 * The dialog body is a separate component that only exists while `open` is
 * true, so closing it unmounts the state rather than leaving a stale error or
 * a running cooldown behind for the next open.
 */
export function ForgotPasswordModal({ open, onClose }: Props) {
  if (!open) return null;
  return <ForgotPasswordDialog onClose={onClose} />;
}

function ForgotPasswordDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cooldownSec, setCooldownSec] = useState(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Never leave an interval running behind an unmounted dialog.
  useEffect(() => clearTimer, [clearTimer]);

  // Escape closes; the page behind must not scroll while the modal is up.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  function startCooldown() {
    clearTimer();
    setCooldownSec(COOLDOWN_SECONDS);
    timerRef.current = setInterval(() => {
      setCooldownSec((remaining) => {
        if (remaining <= 1) {
          clearTimer();
          return 0;
        }
        return remaining - 1;
      });
    }, 1000);
  }

  async function handleSend() {
    if (status === 'sending' || cooldownSec > 0) return;

    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) {
      setErrorMsg('กรุณากรอกอีเมลที่ถูกต้อง');
      setStatus('error');
      return;
    }

    setStatus('sending');
    setErrorMsg(null);

    try {
      const supabase = getBrowserSupabase();
      const { error } = await supabase.auth.resetPasswordForEmail(trimmed, {
        // Origin-relative, never hardcoded: the same build has to work on
        // localhost, on Vercel previews and on creatorlivetech.com.
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) {
        setStatus('error');
        setErrorMsg('ไม่สามารถส่งอีเมลได้ กรุณาลองใหม่ในอีกสักครู่');
        return;
      }
    } catch {
      setStatus('error');
      setErrorMsg('ไม่สามารถส่งอีเมลได้ กรุณาลองใหม่ในอีกสักครู่');
      return;
    }

    setStatus('sent');
    startCooldown();
  }

  const sending = status === 'sending';

  return (
    <div
      className="aurum-modal__scrim"
      role="presentation"
      // Click-outside closes, but only on the scrim itself — a click that
      // started inside the card and drifted out must not dismiss it.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="aurum-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="forgot-password-title"
      >
        <button
          type="button"
          className="aurum-modal__close"
          aria-label="ปิด"
          onClick={onClose}
        >
          <CloseIcon />
        </button>

        {status !== 'sent' ? (
          <>
            <div className="aurum-modal__icon">
              <MailIcon />
            </div>
            <h3 className="aurum-modal__title" id="forgot-password-title">
              ลืมรหัสผ่าน?
            </h3>
            <p className="aurum-modal__text">
              กรอกอีเมลที่ใช้สมัคร
              <br />
              เราจะส่งลิงก์รีเซ็ตรหัสผ่านให้ภายใน 1 นาที
            </p>

            <form
              className="aurum-modal__form"
              // Our own Thai validation is authoritative here: the browser's
              // native email check would otherwise swallow the submit and show
              // its own English bubble instead.
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void handleSend();
              }}
            >
              <label className="aurum-auth__field" htmlFor="forgot-email">
                <span className="aurum-auth__label">อีเมล</span>
                <input
                  id="forgot-email"
                  className="aurum-auth__input"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  disabled={sending}
                  autoFocus
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setErrorMsg(null);
                    setStatus('idle');
                  }}
                />
              </label>

              {errorMsg && (
                <p className="aurum-auth__error" role="alert">
                  <span>{errorMsg}</span>
                </p>
              )}

              <button
                type="submit"
                className="aurum-auth__submit"
                disabled={sending || cooldownSec > 0}
              >
                {sending ? (
                  <>
                    <Spinner />
                    กำลังส่ง...
                  </>
                ) : (
                  'ส่งลิงก์รีเซ็ต'
                )}
              </button>
            </form>

            <p className="aurum-modal__hint">
              ไม่ได้รับอีเมล? ตรวจโฟลเดอร์ Junk / Spam
            </p>
          </>
        ) : (
          <>
            <div className="aurum-modal__icon is-success">
              <CheckIcon />
            </div>
            <h3 className="aurum-modal__title" id="forgot-password-title">
              ส่งอีเมลแล้ว
            </h3>
            <p className="aurum-modal__text">
              เราส่งลิงก์รีเซ็ตรหัสผ่านไปที่
              <br />
              <strong>{email.trim()}</strong>
              <br />
              กรุณาตรวจกล่องจดหมายภายใน 1 นาที
            </p>

            <button type="button" className="aurum-modal__ghost" onClick={onClose}>
              ปิด
            </button>

            <p className="aurum-modal__hint">
              {cooldownSec > 0 ? (
                `ส่งอีเมลอีกครั้งได้ในอีก ${cooldownSec} วินาที`
              ) : (
                <button
                  type="button"
                  className="aurum-modal__link"
                  onClick={() => {
                    setStatus('idle');
                    setErrorMsg(null);
                  }}
                >
                  ส่งอีกครั้ง
                </button>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
