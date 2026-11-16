// Local-dev-only entry. The production entry (src/index.ts) re-exports
// many top-level constants for the test suite; workerd's local runtime
// treats every named export of the entry module as a binding and refuses
// to start ("Incorrect type for map entry 'CHAT_RATE_LIMIT_...'"). This
// thin wrapper re-exports ONLY the default fetch handler so `wrangler dev`
// can run the real worker code locally for end-to-end verification.
// Not referenced by production deploy (main stays src/index.ts).
import worker from './index';
export default worker;
