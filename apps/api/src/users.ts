import type { PublicUser } from "@private-chat/contracts";

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  avatarPath: string | null;
  avatarVersion: number;
  mustChangePassword: boolean;
  updatedAt: Date;
}

export function toPublicUser(row: UserRow): PublicUser {
  const role = row.role === "admin" ? ("admin" as const) : ("member" as const);
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role,
    avatarUrl:
      row.avatarPath === null
        ? null
        : `/api/users/${row.id}/avatar?v=${row.avatarVersion}`,
    avatarVersion: row.avatarVersion,
    mustChangePassword: row.mustChangePassword,
    updatedAt: row.updatedAt.toISOString(),
  };
}
