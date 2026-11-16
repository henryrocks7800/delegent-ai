/**
 * Keep old photos and documents out of every later reply.
 *
 * Think's own history trimming shortens old tool output and text but never
 * media, so a photo sent a week ago was sent to the model again with every
 * reply, at about 1,000 tokens each (a PDF far more), until compaction. The
 * file itself stays stored: the attachment note beside it keeps its name and
 * id, so attach_file can still email or save it. Once a part is replaced it
 * stays replaced, so the prompt prefix stays cacheable from then on.
 */
import type { ModelMessage } from 'ai';

/** Photos and files in the last this-many user messages are sent whole. */
export const MEDIA_KEEP_USER_TURNS = 2;

const note = (name: string | undefined) => ({
  type: 'text' as const,
  text: `[${name ? `The file ${name}` : 'A photo'} the user sent earlier is not shown again, to keep replies fast. What it showed is in the conversation above. If you need to look at it again, ask the user to send it again. It can still be attached with attach_file.]`,
});

export function dropOldMedia(messages: readonly ModelMessage[], keep = MEDIA_KEEP_USER_TURNS): ModelMessage[] | null {
  let users = 0;
  let cutoff = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role !== 'user') continue;
    users += 1;
    if (users === keep) { cutoff = index; break; }
  }
  if (cutoff <= 0) return null;
  let changed = false;
  const out = messages.map((message, index) => {
    if (index >= cutoff || message.role !== 'user' || !Array.isArray(message.content)) return message;
    let here = false;
    const content = message.content.map((part) => {
      if (part.type !== 'image' && part.type !== 'file') return part;
      here = true;
      return note(part.type === 'file' ? part.filename : undefined);
    });
    if (!here) return message;
    changed = true;
    return { ...message, content } as ModelMessage;
  });
  return changed ? out : null;
}
