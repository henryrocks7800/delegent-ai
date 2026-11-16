import type { NextConfig } from 'next';

/**
 * Security headers applied to every web response. These are intentionally
 * conservative — the web app is a thin shell today and there is no inline
 * scripting, no third-party iframes, no analytics tags. When real features
 * land (Stripe Checkout, Supabase auth helpers), the CSP `script-src` and
 * `connect-src` directives will need to be widened to include the domains
 * those features require — never with `'unsafe-inline'` if avoidable.
 */
const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'interest-cohort=(), camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    // `'unsafe-inline'` is only kept for `style-src` because Next 13+ injects
    // small inline style blocks for hydration. Once Next ships nonces by
    // default that exception can be removed.
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://checkout.stripe.com",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS.map(({ key, value }) => ({ key, value })),
      },
    ];
  },
};

export default nextConfig;
