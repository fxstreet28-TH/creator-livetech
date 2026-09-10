/**
 * The two things the studio says to a creator about screen sharing.
 *
 * In a module of their own, and not because two strings needed a home: both
 * are checked by the bench, and a bench that asserted against its own copy of
 * a sentence would pass for as long as the sentence never changed and stop
 * meaning anything the moment it did.
 */

/**
 * WHICH SURFACE TO PICK, said before the picker opens.
 *
 * Chrome's picker offers แท็บ / หน้าต่าง / หน้าจอ and a page cannot preselect
 * any of them — the choice is the browser's to present and the creator's to
 * make, which is the whole security model of display capture. What a page CAN
 * do is say which one is better, in the second before the chooser appears.
 *
 * And a tab genuinely is better, twice over. It is SHARPER: a tab is captured
 * from the renderer's own output, while a window is composited by the OS and
 * then captured, which is a resample nobody asked for. And it is CLEANER: Por's
 * recording has the browser's tab strip and address bar in the broadcast,
 * because he shared the window rather than the tab inside it.
 */
export const SHARE_PICKER_HINT =
  'เลือก แท็บ TradingView/MT5 จะคมกว่าและไม่ติดแถบเบราว์เซอร์';

/**
 * The source went away without the studio asking.
 *
 * A frozen top slot is the wrong way to say this and was the old way to see
 * it: the composite falls back to the camera, which is correct, and a creator
 * who does not know why their chart vanished will assume the studio broke.
 */
export const SHARE_ENDED_NOTICE = 'การแชร์หยุดลง — แชร์ใหม่ได้เลย';
