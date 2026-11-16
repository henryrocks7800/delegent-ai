interface MarkProps {
  size?: number;
  className?: string;
}

// Two brand files exist on purpose, and they are not interchangeable:
//
//   /app-icon.png    square, OPAQUE off-white tile. Favicon and apple-touch-icon.
//                    Those must not be transparent, or iOS composites the mark
//                    onto black when it is saved to a home screen.
//   /brand-mark.png  transparent, no tile. Everything rendered ON a page.
//
// This component is the on-page logo, so it takes the transparent one. It used
// to take app-icon.png with a rounded-[14px] class, which drew the icon's navy
// tile as a rounded square sitting on the page: the "icon box" Alex reported.
// There is no tile left to round, so the class is gone too.
//
// 2026-09-26: the header drew the 620 KB, 768px original at 32px on every page
// load. It now takes a 96px copy (15 KB, still sharp at 3x) up to 48px, and the
// 192px copy above that. The original stays for anything that needs it.
export function Mark({ size = 36, className = '' }: MarkProps) {
  return (
    <img
      src={size <= 48 ? '/brand-mark-96.png' : '/brand-mark-192.png'}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
      loading="eager"
      className={className}
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  );
}
