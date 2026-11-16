/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm "Quiet" palette (2026-07-23): shifted from cool white toward the
        // warm cream + softer sage of the Delegent house style, so the site
        // reads warmer and more inviting while keeping strong text contrast.
        bg: '#F5F2EB',
        surface: '#FBF9F4',
        ink: {
          DEFAULT: '#262420',
          muted: '#6C665A',
          faint: '#938C7D',
        },
        sage: {
          DEFAULT: '#4F6152',
          soft: '#E7EDE5',
          deep: '#3B4A40',
        },
        divider: '#E4DDCF',
        accent: {
          success: '#4A7A4A',
          warning: '#B8956E',
          danger: '#B64949',
          telegram: '#2481CC',
        },
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['"Instrument Serif"', 'ui-serif', 'Georgia', 'serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        // Match mobile token scale
        'display-xl': ['56px', { lineHeight: '1.05', letterSpacing: '-0.02em', fontWeight: '500' }],
        'display-lg': ['44px', { lineHeight: '1.08', letterSpacing: '-0.015em', fontWeight: '500' }],
        'display-md': ['28px', { lineHeight: '1.15', letterSpacing: '-0.01em', fontWeight: '500' }],
        'title': ['18px', { lineHeight: '1.4', fontWeight: '500' }],
        'body-lg': ['18px', { lineHeight: '1.55', fontWeight: '400' }],
        'body': ['15.5px', { lineHeight: '1.65', fontWeight: '400' }],
        'caption': ['11px', { lineHeight: '1.4', fontWeight: '500', letterSpacing: '0.08em' }],
      },
      spacing: {
        // 4pt grid keystops
        '18': '4.5rem',
        '22': '5.5rem',
        '30': '7.5rem',
      },
      maxWidth: {
        'page': '1180px',
        'narrow': '780px',
        'prose': '64ch',
      },
      borderRadius: {
        'pill': '999px',
        'card': '20px',
      },
      boxShadow: {
        'quiet': '0 1px 0 rgba(14,14,12,0.04), 0 12px 32px -22px rgba(14,14,12,0.18)',
        'lift': '0 2px 0 rgba(14,14,12,0.04), 0 24px 48px -28px rgba(14,14,12,0.22)',
      },
      transitionTimingFunction: {
        'quiet': 'cubic-bezier(0.2, 0.0, 0.0, 1.0)',
      },
    },
  },
  plugins: [],
};
