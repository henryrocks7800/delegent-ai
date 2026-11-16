/**
 * How far the soft keyboard covers the chat, in dp, on Android.
 *
 * The two positions come from different origins. React Native's measureInWindow
 * reports a view relative to the window's visible frame, which starts below the
 * status bar (it subtracts getWindowVisibleDisplayFrame().top), while the
 * keyboard's screenY is measured from the top of the screen. Subtracting one
 * from the other came out short by exactly the status bar height, so the text
 * box and the Send button sat partly behind the keyboard, and a tap on Send
 * landed on the keyboard instead. On the Android 16 emulator the chat ended at
 * 1,980 px with the keyboard starting at 1,848 px: the 156 px status bar less
 * the 8 dp gap (QA, 2026-09-23).
 *
 * viewportTop is that status bar height, StatusBar.currentHeight, which React
 * Native takes from the same top inset.
 */
export function keyboardOverlapDp(input: {
  viewY: number;
  viewHeight: number;
  viewportTop: number;
  keyboardTop: number;
}): number {
  const { viewY, viewHeight, viewportTop, keyboardTop } = input;
  if (![viewY, viewHeight, viewportTop, keyboardTop].every(Number.isFinite)) return 0;
  return Math.max(0, Math.round(viewY + viewportTop + viewHeight - keyboardTop));
}
