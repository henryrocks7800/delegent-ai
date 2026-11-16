export function TelegramMock() {
  return (
    <div className="relative mx-auto w-full max-w-[420px] rounded-[32px] bg-white shadow-lift ring-1 ring-divider overflow-hidden">
      {/* Phone bezel hint */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 h-1.5 w-24 rounded-full bg-ink/10" aria-hidden />

      {/* App header */}
      <div className="px-5 pt-8 pb-4 border-b border-divider flex items-center gap-3 bg-bg/50">
        <div className="h-9 w-9 rounded-full bg-sage flex items-center justify-center text-white text-[15px] brand-serif">
          N
        </div>
        <div className="flex-1">
          <p className="text-[14.5px] font-medium leading-tight">Nova</p>
          <p className="text-[11.5px] text-ink-muted leading-tight">your Delegent digital employee · online</p>
        </div>
        <div className="text-ink-faint">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M3 5h18M3 12h18M3 19h18" />
          </svg>
        </div>
      </div>

      {/* Chat surface */}
      <div className="px-5 py-5 space-y-3 bg-white">
        <Outgoing>Draft a polite reply to the landlord saying we'll send the deposit by Friday.</Outgoing>
        <Incoming>Done, draft is in your files as <em>landlord-reply.docx</em>. Want me to keep it as a review draft for you to send?</Incoming>

        <Outgoing>Add the next step to my Friday checklist draft.</Outgoing>
        <Incoming>
          Done. I&apos;ve added <strong>&ldquo;Confirm landlord received deposit&rdquo;</strong> to a checklist draft in Files so you can review it before Friday.
        </Incoming>

        <Outgoing className="opacity-80">Summarise these receipt lines for last week.</Outgoing>
        <Typing />
      </div>

      {/* Input bar */}
      <div className="px-5 py-3 border-t border-divider flex items-center gap-3 bg-bg/50">
        <div className="flex-1 h-9 rounded-pill bg-white border border-divider flex items-center px-4 text-[13px] text-ink-faint">
          Message Nova…
        </div>
        <button
          className="h-9 w-9 rounded-full bg-sage text-white flex items-center justify-center"
          aria-label="Send"
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
            <path d="M5 12l14-7-5 14-2-7-7-?" />
            <path d="M5 12l14-7-5 14-3-6-6-1z" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function Incoming({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex">
      <div className="max-w-[82%] rounded-2xl rounded-bl-md bg-sage-soft text-sage-deep px-4 py-2.5 text-[13.5px] leading-[1.45]">
        {children}
      </div>
    </div>
  );
}

function Outgoing({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex justify-end ${className}`}>
      <div className="max-w-[82%] rounded-2xl rounded-br-md bg-[#EEF1EE] text-ink px-4 py-2.5 text-[13.5px] leading-[1.45]">
        {children}
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div className="flex">
      <div className="rounded-2xl rounded-bl-md bg-sage-soft px-4 py-3 inline-flex items-center gap-1.5">
        <Pulse delay={0} />
        <Pulse delay={120} />
        <Pulse delay={240} />
      </div>
    </div>
  );
}

function Pulse({ delay }: { delay: number }) {
  return (
    <span
      className="block h-1.5 w-1.5 rounded-full bg-sage/70"
      style={{ animation: `pulse 1.2s ${delay}ms ease-in-out infinite` }}
    />
  );
}
