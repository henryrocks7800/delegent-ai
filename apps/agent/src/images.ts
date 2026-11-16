// A smaller copy of a big photo for the model to look at (Cloudflare Images),
// and the ceiling on what may enter a conversation at all.
//
// Kept apart from agent.ts, which needs the Workers runtime, so it can be tested.

/**
 * Big phone photos are misread by the model. A 6.8 MB photo of an EV charger
 * came back as "an Adidas item" and then "an extension lead"; the same photo at
 * 2048 px on its long side was read correctly, in half the time (Alex's photo,
 * 2026-09-15). So the model is given a copy no bigger than that, while the
 * original stays stored for attaching to an email or saving to an app.
 */
const MODEL_IMAGE_MAX_PX = 2048;
const MODEL_IMAGE_SMALLER_PX = 1280;

/**
 * The most any one file may add to a conversation.
 *
 * Whatever sits in the conversation is carried into every later turn and, when
 * the framework moves it out of the context, written into the Durable Object's
 * SQLite. A 6.8 MB photo failed that write with SQLITE_TOOBIG on every turn and
 * the reply died with it: Alex's chat answered "That reply did not finish"
 * to everything until it was cleared (2026-09-16). Anything above this is left
 * out of the conversation and the person is told, rather than breaking it.
 */
export const MODEL_FILE_MAX_BYTES = 1_000_000;

async function transformed(images: ImagesBinding, bytes: Uint8Array, px: number, quality: number): Promise<Uint8Array | null> {
  const result = await images
    .input(new Blob([new Uint8Array(bytes)]).stream())
    .transform({ width: px, height: px, fit: 'scale-down' })
    .output({ format: 'image/jpeg', quality });
  const out = new Uint8Array(await result.response().arrayBuffer());
  return out.byteLength > 0 ? out : null;
}

/**
 * What the model should see for this file: a scaled-down copy of a big image,
 * or the original when it is already small enough. A photo that cannot be
 * brought under the ceiling, and any other file over it, comes back as
 * `tooLarge` so the caller leaves it out of the conversation.
 */
export async function imageForModel(
  images: ImagesBinding | undefined,
  mime: string,
  bytes: Uint8Array,
): Promise<{ mime: string; bytes: Uint8Array; tooLarge?: true }> {
  if (bytes.byteLength <= MODEL_FILE_MAX_BYTES) return { mime, bytes };
  const isImage = /^image\/(jpeg|png|webp)$/.test(mime);
  if (!images || !isImage) return { mime, bytes, tooLarge: true };
  try {
    for (const [px, quality] of [[MODEL_IMAGE_MAX_PX, 85], [MODEL_IMAGE_SMALLER_PX, 75]] as const) {
      const smaller = await transformed(images, bytes, px, quality);
      if (smaller && smaller.byteLength <= MODEL_FILE_MAX_BYTES) return { mime: 'image/jpeg', bytes: smaller };
    }
    return { mime, bytes, tooLarge: true };
  } catch (error) {
    // Never lose the photo over a resize, but never carry the original into the
    // conversation either: that is what broke a chat.
    console.warn(JSON.stringify({ agent: 'image_resize_failed', bytes: bytes.byteLength, error: error instanceof Error ? error.name : 'unknown' }));
    return { mime, bytes, tooLarge: true };
  }
}
