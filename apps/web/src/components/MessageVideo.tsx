import { useEffect, useState } from 'react';

export function MessageVideo({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (broken) return <p className="text-sm text-muted">Video no disponible.</p>;
  return <video key={src} src={src} aria-label="Video enviado" controls playsInline preload="metadata"
    onError={() => setBroken(true)} className="block max-h-80 w-full max-w-full rounded-xl bg-black" />;
}

export function PendingVideo({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src ? <video src={src} aria-label="Video pendiente" controls playsInline preload="metadata"
    className="mb-2 block max-h-60 max-w-full rounded-xl bg-black" /> : null;
}
