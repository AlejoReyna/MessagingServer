import { defineConfig } from "prisma/config";

// La URL de migraciones la aporta el propietario (OWNER_DATABASE_URL o
// DATABASE_URL). Nunca se imprime en logs.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["OWNER_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? "",
  },
});
