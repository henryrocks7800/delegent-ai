interface WordmarkProps {
  size?: 'sm' | 'md' | 'lg';
  inverted?: boolean;
}

const SIZE_MAP = {
  sm: { delegent: 'text-[20px]', ai: 'text-[14px] tracking-[0.06em]' },
  md: { delegent: 'text-[26px]', ai: 'text-[16px] tracking-[0.06em]' },
  lg: { delegent: 'text-[44px]', ai: 'text-[24px] tracking-[0.05em]' },
};

export function Wordmark({ size = 'md', inverted = false }: WordmarkProps) {
  const cls = SIZE_MAP[size];
  const ink = inverted ? 'text-white' : 'text-ink';
  return (
    <span className={`inline-flex items-baseline gap-[0.25em] ${ink}`}>
      <span className={`brand-serif leading-none ${cls.delegent}`}>Delegent</span>
      <span className={`font-sans font-medium leading-none ${cls.ai}`}>AI</span>
    </span>
  );
}
