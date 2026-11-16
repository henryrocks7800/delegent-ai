// One scroll engine for the whole page. Every animated section registers here
// instead of adding its own scroll listener, so a phone scrolling the page does
// one getBoundingClientRect pass per frame, not twenty.
//
// Progress is written straight onto the element as the CSS variable --p (0 to
// 1). The CSS does the animating (transforms and opacity only), so React never
// re-renders on scroll. A section that needs to know WHICH step it is on (the
// Money Finder story) passes onChange and only gets a callback when the value
// moves, which it then quantises before touching state.

export type ProgressMode =
  /** 0 when the element's top meets the viewport's bottom, 1 when its bottom meets the viewport's top. */
  | 'pass'
  /** Scrubs through a tall sticky container: 0 when its top reaches the top, 1 when its bottom reaches the bottom. */
  | 'sticky'
  /** An entrance: 0 when the top meets the viewport's bottom, 1 when the top reaches 35% down the viewport. */
  | 'enter'
  /** An exit, for the first screen: 0 while its top is at the top of the page, 1 once it has scrolled fully away. */
  | 'leave'
  /** Reading pace: 0 when the top is three-quarters down the screen, 1 when the bottom reaches the middle. */
  | 'read';

interface Item {
  el: HTMLElement;
  mode: ProgressMode;
  last: number;
  onChange?: (p: number) => void;
}

const items = new Set<Item>();
let queued = false;
let listening = false;

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function measure() {
  queued = false;
  const vh = window.innerHeight || 1;
  for (const it of items) {
    const r = it.el.getBoundingClientRect();
    let p: number;
    if (it.mode === 'sticky') {
      const travel = r.height - vh;
      p = travel > 0 ? clamp(-r.top / travel) : r.top <= 0 ? 1 : 0;
    } else if (it.mode === 'enter') {
      p = clamp((vh - r.top) / (vh * 0.65));
    } else if (it.mode === 'leave') {
      p = clamp(-r.top / (r.height || 1));
    } else if (it.mode === 'read') {
      p = clamp((vh * 0.75 - r.top) / (r.height + vh * 0.25));
    } else {
      p = clamp((vh - r.top) / (vh + r.height));
    }
    if (Math.abs(p - it.last) > 0.0004) {
      it.last = p;
      it.el.style.setProperty('--p', p.toFixed(4));
      it.onChange?.(p);
    }
  }
}

function queue() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(measure);
}

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue, { passive: true });
}

export function trackProgress(el: HTMLElement, mode: ProgressMode, onChange?: (p: number) => void): () => void {
  const item: Item = { el, mode, last: -1, onChange };
  items.add(item);
  listen();
  queue();
  return () => {
    items.delete(item);
  };
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** True on devices with a mouse or trackpad, where pointer-follow effects make sense. */
export function hasFinePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;
}
