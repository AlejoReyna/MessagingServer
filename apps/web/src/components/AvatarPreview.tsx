import { useEffect, useState } from 'react';
import type { PublicUser } from '@private-chat/contracts';
import { avatarSrc } from '../lib/api';
import { AvatarLightbox } from './AvatarLightbox';

export function AvatarPreview({ user, onClose }: { user: PublicUser; onClose: () => void }) {
  const src = avatarSrc(user);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);

  return (
    <AvatarLightbox title={`Foto de perfil de ${user.displayName}`} onClose={onClose}>
      <div className="avatar-preview grid shrink-0 place-items-center overflow-hidden rounded-full bg-white/10 ring-1 ring-white/20">
        {src && !broken ? (
          <img key={src} src={src} alt={`Foto de perfil de ${user.displayName}`}
            className="h-full w-full object-cover" onError={() => setBroken(true)} />
        ) : <span className="text-6xl font-medium">{user.displayName.slice(0, 2).toUpperCase()}</span>}
      </div>
      {broken && <p role="alert" className="text-center text-sm text-white/70">No se pudo cargar la foto.</p>}
      {!src && <p className="text-center text-sm text-white/70">No tiene foto de perfil.</p>}
    </AvatarLightbox>
  );
}
