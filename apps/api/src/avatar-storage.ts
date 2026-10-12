import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { avatarExtension, type AvatarFormat } from "./avatar.js";

const managedFilename = /^[0-9a-f-]{36}\.(?:jpg|png|webp)$/i;

export async function removeAvatarFile(uploadDir: string, filename: string | null): Promise<void> {
  if (!filename) return;
  if (!managedFilename.test(filename)) throw new Error("INVALID_AVATAR_PATH");
  try {
    await fs.unlink(join(resolve(uploadDir), "avatars", filename));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Serializa escritura y limpieza también entre procesos del servidor. */
export async function replaceAvatar(
  db: PrismaClient, uploadDir: string, userId: string,
  image: { bytes: Buffer; format: AvatarFormat } | null,
) {
  const filename = image ? `${randomUUID()}.${avatarExtension(image.format)}` : null;
  let committed = false;
  try {
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(76162, 1)`;
      const previous = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarPath: true } });
      if (image && filename) {
        const directory = join(resolve(uploadDir), "avatars");
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(join(directory, filename), image.bytes, { flag: "wx", mode: 0o600 });
      }
      const user = await tx.user.update({
        where: { id: userId },
        data: { avatarPath: filename, avatarVersion: { increment: 1 } },
      });
      return { user, previous: previous.avatarPath };
    });
    committed = true;
    await removeAvatarFile(uploadDir, result.previous);
    return result.user;
  } catch (error) {
    // Si falla la transacción, la foto anterior sigue siendo la válida.
    if (!committed) await removeAvatarFile(uploadDir, filename);
    throw error;
  }
}

/** Recupera archivos huérfanos de una interrupción; no guarda versiones. */
export async function pruneOrphanAvatars(db: PrismaClient, uploadDir: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(76162, 1)`;
    const users = await tx.user.findMany({ select: { avatarPath: true } });
    const active = new Set(users.map((user) => user.avatarPath));
    const directory = join(resolve(uploadDir), "avatars");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const filename of await fs.readdir(directory)) {
      if (managedFilename.test(filename) && !active.has(filename)) await removeAvatarFile(uploadDir, filename);
    }
  });
}
