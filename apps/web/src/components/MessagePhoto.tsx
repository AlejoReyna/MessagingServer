import { useEffect, useState } from 'react';
import { AvatarLightbox } from './AvatarLightbox';

export function MessagePhoto({ src }: { src: string }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);
  if (broken) return <p className="text-sm text-muted">Foto no disponible.</p>;
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label="Ver foto" className="mb-2 block max-w-full overflow-hidden rounded-2xl focus-visible:outline-accent">
      <img src={src} alt="Foto enviada" loading="lazy" onError={() => setBroken(true)}
        className="max-h-80 w-auto max-w-full object-contain" />
    </button>
    {open && <AvatarLightbox title="Foto" onClose={() => setOpen(false)}>
      <img src={src} alt="Foto ampliada" className="max-h-[70dvh] w-auto max-w-full rounded-xl object-contain" />
    </AvatarLightbox>}
  </>;
}

export function PendingPhoto({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src ? <img src={src} alt="Foto pendiente" className="mb-2 max-h-60 max-w-full rounded-2xl object-contain" /> : null;
}
