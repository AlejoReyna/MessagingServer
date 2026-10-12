import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function localEnvironment(owner = false) {
  return {
    ...process.env,
    APP_ENV: 'development', APP_ORIGIN: 'http://127.0.0.1:5173', HOST: '127.0.0.1', PORT: '3000',
    DATABASE_HOST: '127.0.0.1', DATABASE_PORT: '5432', DATABASE_NAME: 'private_chat',
    DATABASE_USER: owner ? 'private_chat_owner' : 'private_chat_app',
    DATABASE_PASSWORD_FILE: resolve(projectRoot, `.secrets/${owner ? 'db_owner_password' : 'db_app_password'}`),
    COOKIE_SECRET_FILE: resolve(projectRoot, '.secrets/cookie_secret'),
    CSRF_SECRET_FILE: resolve(projectRoot, '.secrets/csrf_secret'),
    UPLOAD_DIR: resolve(projectRoot, '.data/uploads'),
    DELETION_JOURNAL_PATH: resolve(projectRoot, '.data/journal/deletions.jsonl'),
    ADMIN_USERNAME: process.env.ADMIN_USERNAME ?? 'admin', PARTNER_USERNAME: process.env.PARTNER_USERNAME ?? 'member',
    ADMIN_DISPLAY_NAME: process.env.ADMIN_DISPLAY_NAME ?? 'Administrador',
    MEMBER_DISPLAY_NAME: process.env.MEMBER_DISPLAY_NAME ?? 'Miembro',
    ADMIN_AVATAR_FILE: process.env.ADMIN_AVATAR_FILE,
    MEMBER_AVATAR_FILE: process.env.MEMBER_AVATAR_FILE,
    ADMIN_PIN_FILE: resolve(projectRoot, '.secrets/admin_pin'),
    GUEST_SETUP_SECRET_FILE: resolve(projectRoot, '.secrets/guest_setup_secret'),
  };
}
