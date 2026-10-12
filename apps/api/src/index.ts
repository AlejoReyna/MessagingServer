import { loadConfig, configSummary } from "./config.js";
import { getDb, closeDb } from "./db.js";
import { buildApp, startServer } from "./http/app.js";
import { reconcileDeletions } from "./reconciliation.js";
import { pruneOrphanAvatars } from "./avatar-storage.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = getDb(config.databaseUrl);
  await reconcileDeletions(db, config.deletionJournalPath);
  await pruneOrphanAvatars(db, config.uploadDir);
  const app = await buildApp({ config, db });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Recibida señal ${signal}; cerrando`);
    try {
      await app.close();
    } finally {
      await closeDb();
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await startServer(app, config, db);
  app.log.info({ config: configSummary(config) }, "API lista");
}

main().catch(() => {
  process.stderr.write("No se pudo arrancar el API. Revisa configuración, PostgreSQL y journal; no se abrió HTTP.\n");
  process.exit(1);
});
