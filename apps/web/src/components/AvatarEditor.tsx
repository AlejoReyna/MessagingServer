import { useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import type { PublicUser } from '@private-chat/contracts';
import { avatarSrc, uploadAvatar, validateAvatarFile } from '../lib/api';
import { AvatarLightbox } from './AvatarLightbox';

export function AvatarEditor({ me, csrfToken, onSaved, onClose }: {
  me: PublicUser;
  csrfToken: string;
  onSaved: (user: PublicUser) => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [decoded, setDecoded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function selectFile(next?: File) {
    if (!next || busy) return;
    const problem = validateAvatarFile(next);
    if (problem) { setFile(null); setPreview(null); setDecoded(false); setError(problem); return; }
    setError(null);
    setDecoded(false);
    setPreview(null);
    setFile(next);
  }

  async function save() {
    if (!file || !decoded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await uploadAvatar(file, csrfToken);
      onSaved(user);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la imagen.');
      setBusy(false);
    }
  }

  const src = preview ?? avatarSrc(me);

  return (
    <AvatarLightbox title={file ? 'Vista previa de tu nueva foto' : 'Tu foto de perfil'} onClose={onClose} busy={busy}>
        <div className="avatar-preview grid shrink-0 place-items-center overflow-hidden rounded-full bg-white/10 ring-1 ring-white/20">
          {src ? (
            <img key={src} src={src} alt={`Foto de perfil de ${me.displayName}`} className="h-full w-full object-cover"
              onLoad={() => { if (preview) setDecoded(true); }}
              onError={() => { setDecoded(false); setError('No se pudo leer esta imagen. Elige otra foto.'); }} />
          ) : <span className="text-6xl font-medium">{me.displayName.slice(0, 2).toUpperCase()}</span>}
        </div>
        <p className="text-center text-sm text-white/70">{file ? 'La foto sólo se actualiza al guardar.' : 'Selecciona una imagen para ver cómo quedará.'}</p>
        {error && <p role="alert" className="rounded-xl bg-red-950 px-4 py-2 text-center text-sm text-red-100">{error}</p>}
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Seleccionar nueva imagen"
          className="hidden" onChange={(event) => { selectFile(event.target.files?.[0]); event.target.value = ''; }} />
        <div className="flex w-full max-w-sm flex-wrap justify-center gap-3">
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/30 px-5 text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50">
            <ImagePlus className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" /> Cambiar imagen
          </button>
          {file && (
            <>
              <button type="button" disabled={busy || !decoded} onClick={() => void save()}
                className="min-h-11 rounded-full bg-white px-6 text-sm font-semibold text-black hover:bg-white/90 disabled:opacity-50">
                {busy ? 'Guardando…' : 'Guardar imagen'}
              </button>
              <button type="button" disabled={busy} onClick={onClose}
                className="min-h-11 rounded-full px-5 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50">Cancelar</button>
            </>
          )}
        </div>
        <p className="text-xs text-white/60">JPEG, PNG o WebP · hasta 5 MiB</p>
    </AvatarLightbox>
  );
}
