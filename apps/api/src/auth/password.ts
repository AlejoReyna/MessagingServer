import argon2 from "argon2";

// Argon2id con parámetros explícitos adecuados para inicio de sesión
// interactivo. El hash resultante incluye parámetros y sal; se guarda tal
// cual en users.password_hash.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
