import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// Original geometric artwork; no references, photos or imported illustrations.
const publicDir = new URL('../apps/web/public/', import.meta.url);
await mkdir(publicDir, { recursive: true });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#24292f"/><path d="M128 136h256v200H222l-66 48v-48h-28z" fill="#ffffff"/><circle cx="196" cy="236" r="16" fill="#24292f"/><circle cx="256" cy="236" r="16" fill="#24292f"/><circle cx="316" cy="236" r="16" fill="#24292f"/></svg>\n';
await writeFile(new URL('icon.svg', publicDir), svg);
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['maskable-512.png', 512]]) {
  let pipeline = sharp(Buffer.from(svg));
  if (name.startsWith('maskable')) {
    pipeline = pipeline.resize(384, 384).extend({ top: 64, bottom: 64, left: 64, right: 64, background: '#24292f' });
  } else pipeline = pipeline.resize(size, size);
  await pipeline.png().toFile(new URL(name, publicDir).pathname);
}

// Original synthesized notification tone, with a short smooth envelope.
const rate = 22050;
const samples = Math.round(rate * 0.24);
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
  const t = i / rate;
  const envelope = Math.sin(Math.PI * i / samples) ** 2;
  const value = 0.18 * envelope * (Math.sin(2 * Math.PI * 660 * t) + 0.3 * Math.sin(2 * Math.PI * 880 * t));
  wav.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
}
const sounds = new URL('../apps/web/src/assets/sounds/', import.meta.url);
await mkdir(sounds, { recursive: true });
await writeFile(new URL('notification.wav', sounds), wav);
console.log('Generic icons and original notification tone generated.');
