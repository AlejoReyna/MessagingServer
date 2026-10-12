# Crear el nuevo repositorio

Usar exclusivamente esta copia o el ZIP de fuente preparado, en un repositorio nuevo y vacío. No importar el historial Git de otro proyecto, backups, secretos ni el estado de una instalación. El ZIP no contiene `.git`.

```sh
git init -b main
git config user.name "MessagingServer contributors"
git config user.email "contributors@example.invalid"
git config commit.gpgsign false
git add .
git diff --cached --stat
git commit -m "Initial public source"
git remote add origin https://github.com/AlejoReyna/MessagingServer.git
git push -u origin main
```

Estos comandos son instrucciones para el operador; no se ejecutaron en la preparación. Elegir una identidad de autor local antes del primer commit evita heredar el nombre y correo de la configuración Git global. No afectan otros repositorios. La cuenta y la URL del repositorio de GitHub siguen siendo públicas por elección del operador; la limpieza de fuente no hace anónima esa cuenta.

Antes de publicar, `npm run check:public` comprueba la estructura. Para una revisión con identificadores privados, crear una lista fuera del repositorio (una cadena literal por línea) y ejecutar `node scripts/check-public.mjs --deny-file /ruta/externa/identificadores.txt`. La URL de `package.json.repository` es la excepción permitida. No añadir esa lista al repo.

La licencia es MIT para el proyecto. Conservar los avisos de terceros, incluida la fuente. Las pruebas y el inventario están documentados en `PUBLIC_PREPARATION.md` y `ASSETS_AND_LICENSES.md`.
