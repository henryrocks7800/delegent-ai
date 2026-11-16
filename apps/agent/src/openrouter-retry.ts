/**
 * Retry a model request that OpenRouter reports as briefly rate-limited.
 *
 * Why this exists: Luna is sometimes "temporarily rate-limited upstream" (3 of
 * 30 benchmark jobs on 2026-09-15). OpenRouter sends `200 OK` before generation
 * starts, so that failure arrives as the FIRST event inside the stream
 * (`"error": { "code": 429, "metadata": { "error_type": "rate_limit_exceeded" } }`),
 * not as an HTTP 429. The AI SDK only retries HTTP errors, so without this the
 * user sees the error. Production survives the same thing because the agent's
 * OpenAI client retries.
 *
 * Only a failure BEFORE any output is retried, so nothing is ever shown twice.
 * Every other response is passed through untouched.
 * Source: https://openrouter.ai/docs/api-reference/errors
 */

const RETRY_DELAYS_MS = [500, 1500];
const RETRYABLE_STATUS = new Set([429, 502, 503]);
const RETRYABLE_STREAM_ERROR = /"code"\s*:\s*(429|502|503)\b|rate_limit_exceeded|rate-limited/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function withRateLimitRetry(
  // Wrapped, not passed bare: Workers reject fetch called without its global `this`.
  baseFetch: typeof fetch = (input, init) => fetch(input, init),
  onRetry: (reason: string, attempt: number) => void = () => {}
): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const response = await baseFetch(input, init);
      const canRetry = attempt < RETRY_DELAYS_MS.length && !init?.signal?.aborted;

      if (RETRYABLE_STATUS.has(response.status) && canRetry) {
        await response.body?.cancel();
        onRetry(`HTTP ${response.status}`, attempt + 1);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }

      const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
      if (!canRetry || !response.ok || !isStream || !response.body) return response;

      // Read just far enough to see the first complete data event.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const seen: Uint8Array[] = [];
      let text = "";
      let ended = false;
      while (!/^data:.*\n/m.test(text)) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        seen.push(value);
        text += decoder.decode(value, { stream: true });
      }

      const firstEvent = text.match(/^data:(.*)$/m)?.[1] ?? "";
      if (/"error"\s*:/.test(firstEvent) && RETRYABLE_STREAM_ERROR.test(firstEvent)) {
        await reader.cancel();
        onRetry(firstEvent.slice(0, 160), attempt + 1);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }

      // Healthy (or not ours to judge): hand back the bytes already read, then the rest.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of seen) controller.enqueue(chunk);
          if (ended) controller.close();
        },
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        }
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }
  };
}
