# Avatares opcionales

La distribución no incluye fotos iniciales. El seed admite `ADMIN_AVATAR_FILE` y `MEMBER_AVATAR_FILE` como rutas privadas opcionales del operador. Sólo se leen al crear la cuenta correspondiente. Sin archivos, cada cuenta empieza sin avatar y puede subirlo posteriormente desde su perfil.

Los formatos permitidos son JPEG/PNG/WebP de hasta 5 MiB; se detectan por bytes y se procesan con la misma función Sharp de las subidas HTTP. Se reexportan sin EXIF. No se acepta SVG ni se deriva una ruta de un nombre enviado por el cliente.

`ADMIN_DISPLAY_NAME` y `MEMBER_DISPLAY_NAME` eligen nombres iniciales; los valores predeterminados son Administrador/Miembro. Repetir el seed conserva identidades, fotos, contraseñas e historial existentes. Cambiar la configuración de instalación no reemplaza perfiles posteriores.

El endpoint de avatar es autenticado. Reemplazos y borrados usan exclusión en PostgreSQL y retiran el archivo activo anterior; el arranque limpia huérfanos. Backups incluyen el directorio de uploads y conservan su propia retención. Las pruebas usan imágenes sintéticas generadas con Sharp.
