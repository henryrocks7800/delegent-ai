import { useEffect, useRef, useState, type RefObject } from 'react';
import { hasFinePointer, prefersReducedMotion, trackProgress, type ProgressMode } from './scroll';

/** Writes scroll progress onto the element as --p. Reduced motion pins it at the finished state. */
export function useProgress<T extends HTMLElement>(mode: ProgressMode = 'pass', onChange?: (p: number) => void): RefObject<T> {
  const ref = useRef<T>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      el.style.setProperty('--p', mode === 'pass' ? '0.5' : '1');
      cb.current?.(1);
      return;
    }
    return trackProgress(el, mode, (p) => cb.current?.(p));
  }, [mode]);
  return ref;
}

/**
 * Fires once when the element first scrolls into view (it never "un-blooms" on
 * the way back up, which reads as broken on a phone). Reduced motion reports
 * true straight away so nothing waits to appear.
 */
export function useInView<T extends HTMLElement>(threshold = 0.18, rootMargin = '0px 0px -8% 0px'): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold, rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, threshold, rootMargin]);
  return [ref, seen];
}

/**
 * Pointer spotlight and tilt for cards on desktop: writes --mx/--my (0 to 1)
 * and --rx/--ry (degrees) as the pointer moves. Touch devices get nothing,
 * because a tilt that follows a scrolling thumb feels like a glitch.
 */
export function usePointerGlow<T extends HTMLElement>(maxTilt = 5): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasFinePointer() || prefersReducedMotion()) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.setProperty('--mx', x.toFixed(3));
        el.style.setProperty('--my', y.toFixed(3));
        el.style.setProperty('--ry', `${((x - 0.5) * maxTilt * 2).toFixed(2)}deg`);
        el.style.setProperty('--rx', `${((0.5 - y) * maxTilt * 2).toFixed(2)}deg`);
        el.dataset.hover = 'on';
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      el.style.setProperty('--ry', '0deg');
      el.style.setProperty('--rx', '0deg');
      el.dataset.hover = 'off';
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [maxTilt]);
  return ref;
}

/** Counts up to a value once it is on screen. Reduced motion shows the value immediately. */
export function useCountUp(target: number, run: boolean, durationMs = 1400): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 4);
      setValue(target * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, run, durationMs]);
  return value;
}
