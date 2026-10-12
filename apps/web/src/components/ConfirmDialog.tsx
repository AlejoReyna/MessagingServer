import { useEffect, useRef } from 'react';

export function ConfirmDialog({
  title, body, confirmLabel, onConfirm, onCancel, busy = false, tone = 'danger',
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  tone?: 'danger' | 'default';
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-overlay/50 p-4" role="presentation" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className="w-full max-w-sm rounded-3xl border border-line/70 bg-surface p-6 shadow-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-lg font-bold text-ink">{title}</h2>
        <p id="confirm-body" className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
        <div className="mt-5 flex gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="min-h-[44px] flex-1 rounded-2xl bg-surface-muted px-4 text-sm font-semibold text-ink hover:bg-surface-hover"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`min-h-[44px] flex-1 rounded-2xl px-4 text-sm font-semibold disabled:opacity-60 ${
              tone === 'danger' ? 'bg-danger text-on-danger hover:bg-danger-hover' : 'bg-accent text-on-accent hover:bg-accent-hover'
            }`}
          >
            {busy ? 'Procesando…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
