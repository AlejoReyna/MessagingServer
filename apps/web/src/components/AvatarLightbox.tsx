import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function AvatarLightbox({ title, children, onClose, busy = false }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    <div className="avatar-lightbox fixed inset-0 z-[60] flex flex-col items-center overflow-y-auto px-4 pb-8 pt-16 sm:px-8"
      onClick={() => { if (!busy) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="my-auto flex w-full max-w-xl flex-col items-center gap-5 text-white"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose(); }
          if (event.key !== 'Tab') return;
          const elements = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          const first = elements?.[0];
          const last = elements?.[elements.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <button ref={closeRef} type="button" disabled={busy} onClick={onClose} aria-label="Cerrar vista previa"
          className="absolute left-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-50">
          <X className="h-6 w-6" strokeWidth={1.5} aria-hidden="true" />
        </button>
        <h2 id={titleId} className="text-lg font-medium">{title}</h2>
        {children}
      </div>
    </div>
  );
}
