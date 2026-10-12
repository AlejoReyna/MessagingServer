import sharp from "sharp";
import { MAX_AVATAR_BYTES } from "@private-chat/contracts";

export type AvatarFormat = "jpeg" | "png" | "webp";

export const AVATAR_CONTENT_TYPES: Record<AvatarFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Detecta el formato por bytes mágicos, nunca por el Content-Type declarado.
 * SVG y cualquier otro formato se rechazan (Sharp podría rasterizar SVG,
 * lo que abriría XXE/inclusiones externas: no se le entrega nunca).
 */
export function detectImageFormat(buffer: Buffer): AvatarFormat | null {
  if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return "png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * Valida, decodifica y reexporta la imagen en un formato seguro.
 * Sharp no conserva EXIF salvo petición explícita, así que los
 * metadatos se eliminan por defecto. Lanza Error("INVALID_IMAGE").
 */
export async function processAvatarImage(buffer: Buffer, format: AvatarFormat): Promise<Buffer> {
  try {
    const pipeline = sharp(buffer, { failOn: "error" }).rotate().resize(1024, 1024, {
      fit: "inside",
      withoutEnlargement: true,
    });
    const out =
      format === "jpeg"
        ? await pipeline.jpeg({ quality: 82 }).toBuffer()
        : format === "png"
          ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
          : await pipeline.webp({ quality: 82 }).toBuffer();
    if (out.length === 0 || out.length > MAX_AVATAR_BYTES) throw new Error("INVALID_IMAGE");
    return out;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "INVALID_IMAGE") throw error;
    throw new Error("INVALID_IMAGE");
  }
}

export function avatarExtension(format: AvatarFormat): string {
  return format === "jpeg" ? "jpg" : format;
}
