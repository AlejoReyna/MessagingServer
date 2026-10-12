import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, chmod, lstat, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const secretNames = ['db_owner_password', 'db_app_password', 'cookie_secret', 'csrf_secret', 'backup_password'];

export async function initSecrets(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('La carpeta de secretos debe ser un directorio real.');
  await chmod(directory, 0o700);
  const created = [];
  for (const name of secretNames) {
    const target = join(directory, name);
    try {
      await writeFile(target, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o444 });
      created.push(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Archivo de secretos inválido: ${name}`);
      if (!/^[a-f0-9]{64}\n?$/.test(await readFile(target, 'utf8'))) throw new Error(`Formato de secretos inválido: ${name}`);
    }
    // Lectura dentro de contenedores no-root; el directorio padre 0700 impide lectura de otros usuarios del host.
    await chmod(target, 0o444);
  }
  const repositoryFile = join(directory, 'backup_repository');
  try {
    await writeFile(repositoryFile, 'sftp:backup@YOUR_BACKUP_HOST:/srv/private-chat\n', { flag: 'wx', mode: 0o444 });
    created.push('backup_repository');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(repositoryFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('backup_repository debe ser un archivo real.');
  }
  await mkdir(join(directory, 'backup-ssh'), { recursive: true, mode: 0o700 });
  return created;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const created = await initSecrets(resolve('.secrets'));
    await mkdir(resolve('.data/restore'), { recursive: true, mode: 0o700 });
    console.log(`Secretos preparados: ${created.length} archivos nuevos; valores existentes conservados. No se muestran credenciales.`);
    console.log('Configura backup_repository y backup-ssh antes de usar los respaldos externos.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
