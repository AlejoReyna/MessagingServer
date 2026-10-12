import { useEffect, useState } from 'react';
import { avatarSrc } from '../lib/api';
import type { PublicUser } from '@private-chat/contracts';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

const avatarSizes = {
  44: 'h-11 w-11 text-[15px]',
  48: 'h-12 w-12 text-base',
  52: 'h-[52px] w-[52px] text-lg',
  56: 'h-14 w-14 text-lg',
} as const;

export function AvatarView({
  user, size = 44, ring = false,
}: { user: Pick<PublicUser, 'id' | 'avatarUrl' | 'avatarVersion' | 'displayName'>; size?: keyof typeof avatarSizes; ring?: boolean }) {
  const [broken, setBroken] = useState(false);
  const src = avatarSrc(user);
  useEffect(() => { setBroken(false); }, [src]);
  if (!src || broken) {
    return (
      <span
        aria-hidden="true"
        className={`grid shrink-0 place-items-center rounded-full bg-accent font-semibold text-on-accent ${avatarSizes[size]} ${ring ? 'ring-2 ring-surface' : ''}`}
      >
        {initials(user.displayName)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBroken(true)}
      className={`shrink-0 rounded-full object-cover ${avatarSizes[size]} ${ring ? 'ring-2 ring-surface' : ''}`}
    />
  );
}
