import { Fragment, createElement, type CSSProperties, type ReactNode } from 'react';
import { useInView } from './hooks';

type Effect = 'rise' | 'bloom' | 'fade' | 'left' | 'right';

interface RevealProps {
  children: ReactNode;
  /** rise: up and into focus. bloom: grows out of a soft blur. fade: opacity only. left/right: slides in. */
  effect?: Effect;
  /** Stagger slot, 0 upwards. Each slot adds 80ms. */
  delay?: number;
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  style?: CSSProperties;
  id?: string;
}

/** Wraps anything that should come to life as it scrolls into view. */
export function Reveal({ children, effect = 'rise', delay = 0, as = 'div', className = '', style, id }: RevealProps) {
  const [ref, seen] = useInView<HTMLElement>();
  return createElement(
    as,
    {
      ref,
      id,
      className: `fx fx-${effect} ${seen ? 'is-in' : ''} ${className}`,
      style: { ...style, '--d': `${delay * 80}ms` } as CSSProperties,
    },
    children,
  );
}

interface SplitWordsProps {
  text: string;
  className?: string;
  /** Delay before the first word, in stagger slots. */
  start?: number;
  /** Render immediately (used above the fold) rather than waiting to be scrolled to. */
  eager?: boolean;
  /** Words from this index onward get accentClass (e.g. the serif half of a heading). */
  accentFrom?: number;
  accentClass?: string;
}

/**
 * Headline words that rise one after another. The full sentence stays in the
 * accessibility tree as one piece of text; only the visual spans are split.
 */
export function SplitWords({ text, className = '', start = 0, eager = false, accentFrom, accentClass = '' }: SplitWordsProps) {
  const [ref, seen] = useInView<HTMLSpanElement>(0.1, '0px');
  const words = text.split(' ');
  return (
    <span ref={ref} className={`split ${eager || seen ? 'is-in' : ''} ${className}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {words.map((word, i) => (
          // The space sits OUTSIDE the inline-block mask: inside it, the
          // browser trims it and the words run together.
          <Fragment key={`${word}-${i}`}>
            <span
              className={`split-word ${accentFrom !== undefined && i >= accentFrom ? accentClass : ''}`}
              style={{ '--d': `${(start + i) * 70}ms` } as CSSProperties}
            >
              <span>{word}</span>
            </span>
            {i < words.length - 1 ? ' ' : null}
          </Fragment>
        ))}
      </span>
    </span>
  );
}
