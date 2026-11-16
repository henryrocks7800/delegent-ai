export function Screen({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-app px-4 py-5">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-display-md text-textPrimary">{title}</h1>
          {subtitle ? <p className="mt-1 text-body-sm text-textSecondary">{subtitle}</p> : null}
        </div>
        {/* Without shrink-0 the header action loses the size fight with the
            title and its label wraps onto two lines on a narrow phone. */}
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-body-sm text-textSecondary" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'info' | 'warning' | 'danger'; children: React.ReactNode }) {
  const toneClass =
    tone === 'danger'
      ? 'border-danger text-danger'
      : tone === 'warning'
        ? 'border-warning text-textPrimary'
        : 'border-border text-textSecondary';
  return (
    <div className={`mb-4 rounded-md border bg-surfaceHigh px-3.5 py-3 text-body-sm ${toneClass}`} role="alert">
      {children}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="card px-5 py-10 text-center">
      <p className="text-body font-medium text-textPrimary">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-body-sm text-textSecondary">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center">
      <div className="card w-full max-w-sm p-5" role="dialog" aria-modal="true" aria-label={title}>
        <p className="text-body font-medium text-textPrimary">{title}</p>
        <p className="mt-2 text-body-sm text-textSecondary">{message}</p>
        <div className="mt-5 flex gap-2">
          <button className="btn-secondary flex-1" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`${destructive ? 'btn-danger' : 'btn-primary'} flex-1`}
            type="button"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
