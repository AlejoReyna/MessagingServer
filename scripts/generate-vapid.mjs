// Genera el par VAPID para Web Push (contrato v5, aviso genérico sin texto).
// Uso: node scripts/generate-vapid.mjs
// Crea .secrets/vapid_private_key (base64url 32 bytes, permiso 600) si no
// existe e imprime la VAPID_PUBLIC_KEY y el ejemplo de VAPID_SUBJECT.
// La privada nunca se imprime ni va al repo. Sin Apple Developer.
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile, chmod, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateVapidPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubDer = publicKey.export({ format: 'der', type: 'spki' });
  const raw = pubDer.subarray(pubDer.length - 65);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('No se pudo generar el par VAPID');
  const { d } = privateKey.export({ format: 'jwk' });
  if (!d) throw new Error('No se pudo generar el par VAPID');
  return { publicKey: base64urlEncode(raw), privateKey: d };
}

export async function ensureVapidPrivateKey(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = resolve(directory, 'vapid_private_key');
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('.secrets/vapid_private_key debe ser un archivo real.');
    return { created: false, target };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { publicKey, privateKey } = generateVapidPair();
  await writeFile(target, `${privateKey}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(target, 0o600);
  return { created: true, target, publicKey };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Uso: node scripts/generate-vapid.mjs');
    console.log('Crea .secrets/vapid_private_key (600) si no existe e imprime VAPID_PUBLIC_KEY y VAPID_SUBJECT.');
    console.log('La privada nunca se imprime ni va al repo.');
  } else {
  try {
    const result = await ensureVapidPrivateKey(resolve('.secrets'));
    if (!result.created) {
      console.log('Ya existe .secrets/vapid_private_key; no se generó nada. Deriva la pública del par guardado.');
    } else {
      console.log('Clave privada VAPID creada en .secrets/vapid_private_key (no se muestra).');
      console.log(`VAPID_PUBLIC_KEY=${result.publicKey}`);
      console.log('VAPID_SUBJECT=mailto:tu-correo@example.com');
      console.log('Define ambas variables en el entorno del API y redespliega.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  }
}
