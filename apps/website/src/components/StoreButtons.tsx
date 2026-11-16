import { APP_STORE_URL, IOS_LIVE, PLAY_STORE_URL } from '@sidekick/shared';
import { trackStoreRedirect } from '../lib/metaPixel';

/**
 * Store badges. Play always; the App Store one appears the moment `IOS_LIVE`
 * flips in packages/shared.
 *
 * WHY TWO BUTTONS AND NOT ONE. There is no combined badge, and there cannot
 * be: Apple and Google each require their own supplied artwork and forbid
 * altering or merging it. A single neutral "Get the app" button is the other
 * legitimate option, and that is exactly what /install is for, but badges earn
 * more trust on a landing page, so the home page uses these and adverts use
 * the router.
 */
interface StoreButtonsProps {
  variant?: 'default' | 'inverted';
  size?: 'md' | 'lg';
  className?: string;
}

export function StoreButtons({ variant = 'default', size = 'md', className = '' }: StoreButtonsProps) {
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <StoreButton
        href={PLAY_STORE_URL}
        onClick={() => trackStoreRedirect('google_play')}
        label="Get Delegent AI on Google Play"
        kicker="Get it on"
        name="Google Play"
        mark={<PlayMark />}
        variant={variant}
        size={size}
      />
      {IOS_LIVE ? (
        <StoreButton
          href={APP_STORE_URL}
          onClick={() => trackStoreRedirect('app_store')}
          label="Download Delegent AI on the App Store"
          kicker="Download on the"
          name="App Store"
          mark={<AppleMark />}
          variant={variant}
          size={size}
        />
      ) : null}
    </div>
  );
}

interface StoreButtonProps extends StoreButtonsProps {
  href: string;
  label: string;
  kicker: string;
  name: string;
  mark: React.ReactNode;
  /** Fired on tap-through. No-ops entirely unless the visitor accepted cookies. */
  onClick?: () => void;
}

function StoreButton({ href, label, kicker, name, mark, onClick, variant = 'default', size = 'md' }: StoreButtonProps) {
  const isInverted = variant === 'inverted';
  const surface = isInverted
    ? 'bg-white text-ink hover:bg-bg'
    : 'bg-ink text-white hover:bg-[#1a1a18]';
  const dimensions = size === 'lg' ? 'h-14 px-5' : 'h-12 px-4';

  return (
    <a
      href={href}
      onClick={onClick}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={`inline-flex items-center gap-3 rounded-2xl transition shadow-quiet ${surface} ${dimensions}`}
    >
      {mark}
      <span className="flex flex-col text-left leading-none">
        <span className={`${size === 'lg' ? 'text-[11px]' : 'text-[10px]'} font-medium tracking-[0.08em] uppercase opacity-80`}>
          {kicker}
        </span>
        <span className={size === 'lg' ? 'text-[18px] font-medium' : 'text-[15.5px] font-medium'}>
          {name}
        </span>
      </span>
    </a>
  );
}

function PlayMark() {
  return (
    <svg width="22" height="24" viewBox="0 0 36 40" fill="none" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M3 1.4C2.4 1.8 2 2.6 2 3.6v32.8c0 1 .4 1.8 1 2.2L21.2 21 3 1.4z" fill="#5BC9F4" />
      <path d="M27.6 14.5l-6.4-3.7L3 1.4 21.2 21l6.4-6.5z" fill="#26D07C" />
      <path d="M33.5 17.9l-5.9-3.4L21.2 21l6.4 6.5 5.9-3.4c1.7-1 1.7-3.2 0-4.2z" fill="#FFC107" />
      <path d="M3 40.6c.7.4 1.6.4 2.5-.1l22.1-12.5L21.2 21 3 40.6z" fill="#EA4435" />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg width="21" height="24" viewBox="0 0 24 28" fill="currentColor" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M19.6 14.8c0-3.2 2.6-4.7 2.7-4.8-1.5-2.2-3.8-2.5-4.6-2.5-1.9-.2-3.8 1.2-4.8 1.2-1 0-2.5-1.1-4.1-1.1-2.1 0-4 1.2-5.1 3.1-2.2 3.8-.6 9.3 1.5 12.4 1 1.5 2.3 3.1 3.9 3.1 1.6-.1 2.2-1 4.1-1 1.9 0 2.4 1 4.1 1 1.7 0 2.8-1.5 3.8-3 1.2-1.7 1.7-3.4 1.7-3.5-.1 0-3.2-1.2-3.2-4.9zM16.5 5.4c.9-1 1.4-2.5 1.3-3.9-1.3.1-2.8.9-3.7 1.9-.8.9-1.5 2.4-1.3 3.8 1.4.1 2.9-.7 3.7-1.8z" />
    </svg>
  );
}
