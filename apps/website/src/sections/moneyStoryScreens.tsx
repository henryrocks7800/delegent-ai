// The four phone screens of the Money Finder story (MoneyStory.tsx), drawn in
// HTML in the app's own colours at one fixed size (300 x 624) and scaled to fit
// by the Phone frame. Kept apart from the scroll logic so each can be read on
// its own. Honesty rules for what they show are at the top of MoneyStory.tsx.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { CONNECTABLE_SERVICES } from '@sidekick/shared';
import { prefersReducedMotion } from '../motion/scroll';

const GMAIL = CONNECTABLE_SERVICES.find((service) => service.id === 'gmail');

// Only the two senders that are genuinely part of the story are named. The
// rest are the kind of mail everyone has, so no other company is implied.
const INBOX_FEED = [
  { from: 'British Airways', subject: 'Your flight BA452 has been cancelled', hit: true },
  { from: 'Online order', subject: 'Your order has been dispatched' },
  { from: 'Google Play', subject: 'Your receipt from Google Play', hit: true },
  { from: 'Streaming service', subject: 'Your monthly subscription has renewed', hit: true },
  { from: 'Rail tickets', subject: 'Your e-tickets for Saturday' },
  { from: 'Online shop', subject: 'Your refund is being processed', hit: true },
  { from: 'Your council', subject: 'Your annual bill is ready' },
  { from: 'Energy supplier', subject: 'Your statement is ready' },
];

const d = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties;

function AppBar({ title }: { title?: string }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-[#E7E1D4] px-4 pb-3 pt-11">
      <span className="flex h-8 w-8 items-center justify-center rounded-full ring-1 ring-[#E0D9CB]">
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="#262420" strokeWidth="1.3" strokeLinecap="round">
          <path d="M2 3.5h8M2 6h8M2 8.5h8" />
        </svg>
      </span>
      <img src="/brand-mark-96.png" alt="" width={28} height={28} className="h-7 w-7" />
      <span className="leading-none">
        <span className="block text-[17px]">
          <span className="brand-serif">{title ?? 'Delegent'}</span>
          {title ? null : <span className="ml-1 text-[11px] font-medium tracking-[0.06em]">AI</span>}
        </span>
        <span className="mt-1 flex items-center gap-1 text-[10.5px] text-ink-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-success" />
          Online
        </span>
      </span>
    </div>
  );
}

function Composer() {
  return (
    <div className="absolute inset-x-0 bottom-0 border-t border-[#E7E1D4] bg-[#F4F2EC] px-4 pb-5 pt-2.5">
      <div className="flex items-center justify-between rounded-2xl bg-white px-3.5 py-2.5 ring-1 ring-[#E0D9CB]">
        <span className="text-[12.5px] text-ink-faint">Message Alex…</span>
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#EFEBE2] text-[10px] text-ink-faint">▶</span>
      </div>
    </div>
  );
}

function Label({ who, time }: { who: string; time: string }) {
  return (
    <div className="flex items-center justify-between font-mono text-[10px] text-ink-muted">
      <span>{who === 'You' ? '• You' : `🌿 ${who}`}</span>
      <span>{time}</span>
    </div>
  );
}

export function ConnectScreen() {
  return (
    <div className="h-full">
      <AppBar title="Connections" />
      <div className="space-y-3 px-4 pt-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">Email</p>
        <div className="story-line flex items-center gap-3 rounded-2xl bg-white p-3 ring-1 ring-[#E0D9CB]" style={d(100)}>
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-[#FDECEA]">
            {GMAIL?.brandMark ? (
              <svg width="20" height="20" viewBox={GMAIL.brandMark.viewBox} aria-hidden>
                <path d={GMAIL.brandMark.path} fill={GMAIL.brandMark.color} />
              </svg>
            ) : null}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-[14px] font-medium">Gmail</span>
            <span className="block text-[11px] text-ink-muted">Finds money owed</span>
          </span>
          <span className="relative h-7 w-[82px] flex-none">
            <span className="story-line absolute inset-0 flex items-center justify-center rounded-full bg-sage text-[11px] font-medium text-white" style={d(100)}>
              Connect
            </span>
            <span className="story-line absolute inset-0 flex items-center justify-center gap-1 rounded-full bg-sage-soft text-[11px] font-medium text-sage-deep" style={d(1300)}>
              ✓ Connected
            </span>
          </span>
        </div>
        <div className="story-line flex items-center gap-3 rounded-2xl bg-white p-3 ring-1 ring-[#E0D9CB]" style={d(220)}>
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-[#E6F0FB] text-[13px] font-semibold text-[#0F6CBD]">O</span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-[14px] font-medium">Outlook</span>
            <span className="block text-[11px] text-ink-muted">Read-only, it cannot send</span>
          </span>
          <span className="flex h-7 w-[82px] flex-none items-center justify-center rounded-full bg-sage text-[11px] font-medium text-white">Connect</span>
        </div>
        <div className="story-line rounded-2xl bg-sage-soft/70 p-3" style={d(1600)}>
          <p className="text-[12px] leading-snug text-sage-deep">You sign in on Google’s own page. We never see your password.</p>
        </div>
      </div>
    </div>
  );
}

// Types the request out letter by letter each time the step comes round, and
// wraps like real text (a CSS width animation cannot wrap onto a second line).
const REQUEST = 'Find money I might be owed in my inbox.';

function useTypewriter(text: string, on: boolean, delayMs = 350, perChar = 38): string {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!on) {
      setCount(0);
      return;
    }
    if (prefersReducedMotion()) {
      setCount(text.length);
      return;
    }
    let i = 0;
    let timer = window.setTimeout(function tick() {
      i += 1;
      setCount(i);
      if (i < text.length) timer = window.setTimeout(tick, perChar);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [text, on, delayMs, perChar]);
  return text.slice(0, count);
}

export function AskScreen({ on }: { on: boolean }) {
  const typed = useTypewriter(REQUEST, on);
  const done = typed.length === REQUEST.length;
  return (
    <div className="relative h-full">
      <AppBar />
      <div className="space-y-3.5 px-4 pt-5">
        <div className="flex items-center gap-2 text-[10.5px] text-ink-faint">
          <span className="h-px flex-1 bg-[#E0D9CB]" />✨ Fresh chat<span className="h-px flex-1 bg-[#E0D9CB]" />
        </div>
        <div className="story-line" style={d(150)}>
          <Label who="You" time="09:41" />
          <p className="mt-1.5 min-h-[40px] border-l-2 border-[#C9C1B0] pl-2.5 text-[14px] leading-snug">
            {typed}
            {!done ? <span className="ml-0.5 inline-block h-[15px] w-[2px] translate-y-[2px] bg-sage pulse-dot" /> : null}
          </p>
        </div>
        <div className="story-line" style={d(2300)}>
          <Label who="Alex" time="09:41" />
          <div className="mt-1.5 flex items-center justify-between rounded-xl bg-white px-3 py-2.5 font-mono text-[12px] ring-1 ring-[#E0D9CB]">
            <span>⚡ Working on it</span>
            <span className="h-2 w-2 rounded-full bg-accent-success pulse-dot" />
          </div>
          <p className="mt-2.5 border-l-2 border-sage/50 pl-2.5 text-[12.5px] leading-snug text-ink">
            I’ve started checking your inbox for flight compensation, refunds and subscriptions. The report will appear here.
          </p>
        </div>
      </div>
      <Composer />
    </div>
  );
}

export function ReadScreen({ checked }: { checked: number }) {
  return (
    <div className="relative h-full">
      <AppBar />
      <div className="px-4 pt-5">
        <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2.5 font-mono text-[12px] ring-1 ring-[#E0D9CB]">
          <span>🔎 Reading your inbox</span>
          <span className="h-2 w-2 rounded-full bg-accent-success pulse-dot" />
        </div>
        <p className="mt-4 text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">Likely emails checked</p>
        <p className="brand-serif text-center text-[58px] leading-none text-sage">{checked}</p>
        <div className="relative mt-3 h-[240px] overflow-hidden rounded-2xl bg-white ring-1 ring-[#E0D9CB]">
          <div className="scan-feed">
            {[...INBOX_FEED, ...INBOX_FEED].map((mail, i) => (
              <div
                key={`${mail.subject}-${i}`}
                className={`flex items-center gap-2.5 border-b border-[#F0EBE0] px-3 py-2.5 ${mail.hit ? 'bg-sage-soft/60' : ''}`}
              >
                <span className={`h-2 w-2 flex-none rounded-full ${mail.hit ? 'bg-sage' : 'bg-[#DAD3C4]'}`} />
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[12px] font-medium">{mail.from}</span>
                  <span className="block truncate text-[11px] text-ink-muted">{mail.subject}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-white to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-white to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-12 -translate-y-1/2 bg-gradient-to-b from-transparent via-sage/10 to-transparent" />
        </div>
        <p className="mt-2.5 text-center text-[10.5px] text-ink-faint">Never spam, drafts or sent mail</p>
      </div>
    </div>
  );
}

export function ReportScreen() {
  const lines: Array<{ text: ReactNode; cls?: string }> = [
    { text: 'I checked 255 likely emails in your Outlook inbox. Here is what I found.' },
    { text: 'Money you may be owed, about £220.00:', cls: 'font-medium' },
    { text: '• British Airways, LHR to IBZ, cancelled with 2 days’ notice: up to £220.00 flight compensation', cls: 'pl-1.5' },
    { text: 'Subscriptions, 2 costing about £306.94 a year.', cls: 'font-medium' },
    {
      text: 'Flight claims are possible, not certain, and the amount is per passenger. Nothing was sent or changed. Ask me and I can draft a claim.',
      cls: 'text-ink-muted',
    },
  ];
  return (
    <div className="relative h-full">
      <AppBar />
      <div className="px-4 pt-4">
        <Label who="Alex" time="09:48" />
        <div className="mt-1.5 space-y-2 border-l-2 border-sage/50 pl-2.5">
          {lines.map((line, i) => (
            <p key={i} className={`story-line text-[12.5px] leading-snug ${line.cls ?? ''}`} style={d(200 + i * 260)}>
              {line.text}
            </p>
          ))}
        </div>
      </div>

      {/* The three real refunds, arriving as a notification stack above the
          message box: the newest lands on top, the older ones tuck behind. */}
      <div className="absolute inset-x-3 bottom-[76px] z-10 h-[66px]">
        {[2, 1, 0].map((depth) => (
          <div key={depth} className="toast-in absolute inset-x-0 bottom-0" style={{ ...d(1900 + (2 - depth) * 520), zIndex: 3 - depth }}>
            <div
              className="flex items-center gap-2.5 rounded-2xl bg-white/95 px-3 py-2.5 shadow-lift ring-1 ring-[#E0D9CB] backdrop-blur"
              style={{ transform: `translateY(${-depth * 13}px) scale(${1 - depth * 0.06})`, transformOrigin: '50% 100%' }}
            >
              <PlayGlyph />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="flex justify-between text-[11.5px] font-medium">
                  Google Play <span className="font-normal text-ink-faint">now</span>
                </span>
                <span className="block truncate text-[11px] text-ink-muted">We’ve issued a refund of £18.00</span>
              </span>
            </div>
          </div>
        ))}
        <span className="toast-in absolute -top-4 right-1 z-10 rounded-pill bg-sage px-2 py-0.5 text-[10px] font-medium text-white shadow-quiet" style={d(3100)}>
          3 refunds · £54
        </span>
      </div>
      <Composer />
    </div>
  );
}

function PlayGlyph() {
  return (
    <svg width="18" height="20" viewBox="0 0 36 40" aria-hidden className="flex-none">
      <path d="M3 1.4C2.4 1.8 2 2.6 2 3.6v32.8c0 1 .4 1.8 1 2.2L21.2 21 3 1.4z" fill="#5BC9F4" />
      <path d="M27.6 14.5l-6.4-3.7L3 1.4 21.2 21l6.4-6.5z" fill="#26D07C" />
      <path d="M33.5 17.9l-5.9-3.4L21.2 21l6.4 6.5 5.9-3.4c1.7-1 1.7-3.2 0-4.2z" fill="#FFC107" />
      <path d="M3 40.6c.7.4 1.6.4 2.5-.1l22.1-12.5L21.2 21 3 40.6z" fill="#EA4435" />
    </svg>
  );
}
