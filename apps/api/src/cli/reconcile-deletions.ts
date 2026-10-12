import { loadConfig } from "../config.js";
import { getDb, closeDb } from "../db.js";
import { reconcileDeletions } from "../reconciliation.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const recovery = process.env["RECOVERY_MODE"] === "true";
  try {
    const result = await reconcileDeletions(getDb(config.databaseUrl), config.deletionJournalPath, recovery);
    if (result.restored) process.stdout.write(`Restauración detectada: ${result.restored} mensaje(s) borrado(s) de nuevo\n`);
    process.stdout.write(`Reconciliación completa: ${result.applied} pendientes, ${result.restored} restaurados${recovery ? "; sesiones invalidadas; journal sin cambios" : ""}\n`);
  } finally { await closeDb(); }
}

main().catch(() => {
  // Los errores de drivers/URL podrían contener credenciales.
  process.stderr.write("db:reconcile-deletions falló; revisa disponibilidad DB e integridad del journal. No abrir el servicio.\n");
  process.exitCode = 1;
});
