/** @type {import('tailwindcss').Config} */
// Colours, spacing and radii are transcribed from the mobile design tokens
// (apps/mobile/src/design/tokens.ts) so the web app looks like the same
// product. test/design-tokens.test.mjs checks the colours match.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#FAFAF7',
        surface: '#FAFAF7',
        surfaceHigh: '#FFFFFF',
        // Pearl (2026-09-28): the phone app's accent went from sage to ink,
        // and its hairlines softened; the web app follows so the two, and
        // the chat frame they share, stay one product.
        border: '#ECE9E2',
        borderStrong: '#D3CFC5',
        textPrimary: '#0E0E0C',
        textSecondary: '#6F6E68',
        textTertiary: '#A8A6A0',
        textDisabled: '#C7C5BD',
        accent: '#222220',
        accentMuted: '#ECECE8',
        accentText: '#FAFAF7',
        success: '#4A7A4A',
        warning: '#B8956E',
        danger: '#B64949',
        telegram: '#2481CC',
        email: '#B8956E',
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        brand: ['"Instrument Serif"', 'ui-serif', 'Georgia', 'serif'],
      },
      fontSize: {
        'display-lg': ['36px', { lineHeight: '40px', letterSpacing: '-0.5px', fontWeight: '500' }],
        'display-md': ['28px', { lineHeight: '32px', letterSpacing: '-0.3px', fontWeight: '500' }],
        title: ['16px', { lineHeight: '22px', letterSpacing: '-0.1px', fontWeight: '500' }],
        body: ['15px', { lineHeight: '22px', fontWeight: '400' }],
        'body-sm': ['13px', { lineHeight: '19px', fontWeight: '400' }],
        caption: ['11px', { lineHeight: '14px', letterSpacing: '0.8px', fontWeight: '500' }],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '14px',
        xl: '20px',
        full: '999px',
      },
      maxWidth: {
        app: '760px',
      },
    },
  },
  plugins: [],
};
