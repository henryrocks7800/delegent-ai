// The phone keeps its chat WebView mounted behind every other screen, so a
// command tapped in the menu reaches it immediately. Here the chat is a route,
// so it unmounts the moment the reader opens Commands or Skills. A command
// chosen there is parked in this module, the reader is sent to /chat, and the
// chat screen plays it once the document says its history has loaded.
//
// Waiting for history matters: the document replaces its whole message list
// when the fetch lands, so a command run any earlier loses its own bubble.

export type PendingChatCommand =
  | { kind: 'fresh' }
  | { kind: 'run'; command: string; mode: 'send' | 'compose' };

let pending: PendingChatCommand | null = null;

export function queueChatCommand(next: PendingChatCommand): void {
  pending = next;
}

export function takeChatCommand(): PendingChatCommand | null {
  const current = pending;
  pending = null;
  return current;
}
