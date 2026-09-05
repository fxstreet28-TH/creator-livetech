'use client';

/**
 * The ↗ at the bottom of the reaction rail.
 *
 * The Web Share API where it exists, which on a phone — the only viewport this
 * renders in — is everywhere that matters: it raises the OS sheet, so the live
 * can go to LINE, Messenger or a contact without this app knowing anything
 * about any of them. Everything else falls back to copying the URL, which is
 * the same outcome one paste later.
 *
 * No dependency and no share sheet of our own. A hand-rolled list of networks
 * is a list to maintain, and it would be worse than the one the phone already
 * has.
 */

import { useCallback, useState } from 'react';
import { Check, Share2 } from 'lucide-react';
import { RailButton } from './RailButton';

export function LiveShareButton({
  title,
  compact = false,
}: {
  /** The session's title, offered to the OS sheet as the share text. */
  title: string;
  compact?: boolean;
}) {
  /** Set for a moment after a copy, so the fallback confirms it did something. */
  const [copied, setCopied] = useState(false);

  const share = useCallback(async () => {
    const url = window.location.href;

    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        // AbortError is the viewer dismissing the sheet, which is not a
        // failure and must not fall through to copying a link they did not
        // ask for. Anything else (no permission, an unsupported payload) does
        // fall through — the clipboard still gets them there.
        if (typeof DOMException !== 'undefined') return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      // Clipboard access can be refused outright (an insecure context, a
      // locked-down webview). Nothing useful is left to try, and a live page
      // is not the place for an error dialog about a share button.
      console.error('[LiveShareButton] share and copy both failed', err);
    }
  }, [title]);

  const size = compact ? 14 : 17;

  return (
    <RailButton
      label={copied ? 'คัดลอกลิงก์แล้ว' : 'แชร์ไลฟ์นี้'}
      onClick={() => void share()}
      compact={compact}
    >
      {copied ? <Check size={size} aria-hidden /> : <Share2 size={size} aria-hidden />}
    </RailButton>
  );
}
