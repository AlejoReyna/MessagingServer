import sharp from "sharp";
import { MAX_CHAT_PHOTO_BYTES } from "@private-chat/contracts";
import { detectImageFormat } from "./avatar.js";

export async function processChatPhoto(input: Buffer): Promise<Buffer> {
  if (!detectImageFormat(input)) throw new Error("INVALID_IMAGE");
  const image = sharp(input, { failOn: "error", limitInputPixels: 16_000_000 });
  const metadata = await image.metadata();
  if ((metadata.pages ?? 1) !== 1) throw new Error("INVALID_IMAGE");
  const output = await image.rotate().resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 }).toBuffer();
  if (!output.length || output.length > MAX_CHAT_PHOTO_BYTES) throw new Error("INVALID_IMAGE");
  return output;
}
