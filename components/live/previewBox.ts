/**
 * THE SHAPE OF THE CREATOR'S SELF-VIEW, as one exported function.
 *
 * It is a class string and it is in a module of its own for one reason: it is
 * the fix for F4 and it is therefore something a bench has to be able to check.
 * A bench that measured a box built from its OWN copy of these classes would
 * pass forever and mean nothing; /dev/live-layout mounts a div with exactly
 * this string and measures what the browser does with it.
 *
 * WHAT THE TWO CASES ARE.
 *
 * CAMERA-ONLY is the box the studio has always had: whatever width the column
 * gives it, whatever height the flex row gives it, the camera's own frame
 * `contain`ed inside. Never cropped, never reshaped — PR #61 and #65 settled
 * that, and it is a rule rather than a default: a creator who cannot see their
 * own edges cannot frame themselves.
 *
 * COMPOSITING is 9:16, because that is what the pipeline is publishing. The
 * box was 16:9 through PR #68, and `object-contain` then did the only thing it
 * could with a portrait frame in a landscape box: on Por's 1330px-wide studio
 * it drew about 420px of picture with 900px of black beside it. The published
 * frame did not change; what he could see of it did. Nine-sixteen at the full
 * height of the same space is roughly four times the picture, and it is
 * WYSIWYG in the strong sense — the box and the broadcast are now the same
 * shape, so nothing is being judged through a letterbox.
 *
 * `aspect-[9/16]` with `w-auto` takes the height from the flex row and derives
 * the width; `mx-auto` centres it on the cross axis of the column.
 */
export function previewBoxClass(compositing: boolean): string {
  return [
    'relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-black',
    compositing ? 'mx-auto w-auto aspect-[9/16]' : '',
  ]
    .join(' ')
    .trim();
}
