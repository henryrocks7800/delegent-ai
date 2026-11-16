import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In dev we proxy /api to the live Worker so local development does not depend
// on the production CORS allowlist containing localhost. The browser sees a
// same-origin request; Vite forwards it server-side.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiTarget = env.VITE_DEV_API_PROXY_TARGET || 'https://api.delegantai.co.uk';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        // Scheduling maths and the connection catalogue are plain TypeScript
        // with no React Native imports, so both surfaces read the same file
        // rather than a copy that drifts. Anything under this alias must stay
        // free of platform imports; test/shared-logic.test.mjs enforces that.
        '@mobile-logic': fileURLToPath(new URL('../mobile/src', import.meta.url)),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5181,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true, secure: true },
      },
    },
    build: {
      target: 'es2020',
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
