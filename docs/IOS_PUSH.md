# Notificaciones en iPhone

Requieren HTTPS confiable, una PWA instalada en la pantalla de inicio, iOS 16.4+ y permiso del dispositivo. La configuración del servidor no instala certificados ni concede permiso en el teléfono.

Configurar VAPID en el servidor con `scripts/generate-vapid.mjs`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY_FILE` y `VAPID_SUBJECT`. La clave privada sólo vive en un archivo secreto; sin configuración completa el push está deshabilitado. Desde Ajustes > Notificaciones, activar y aceptar el permiso. El worker `/sw.js` y los iconos se sirven desde el mismo origen.

El aviso siempre dice “Nuevo mensaje” / “Tienes un mensaje nuevo en el chat”, sin remitente, texto, fotos o videos. El envío remoto es vacío; “Probar aviso” sólo verifica una notificación local, no la recepción remota por Apple. Concentración, permisos y ajustes del sistema pueden alterar su presentación.

Las pruebas de servidor inyectan el transporte push y comprueban permisos y suscripciones. No equivalen a una prueba de entrega en un iPhone. Cada instalación requiere una comprobación real en el dispositivo.
