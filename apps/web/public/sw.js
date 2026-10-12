/* Service worker del chat privado (contrato v5).
 * Sólo muestra el aviso genérico del push vacío: "Nuevo mensaje".
 * Sin texto ni remitente: el contenido nunca viaja en el push.
 * Sin imports ni red extra: todo es local y del mismo origen. */
self.addEventListener('push', function (event) {
  // Push vacío por diseño (contrato v5): siempre aviso genérico, sin leer
  // event.data aunque existiera. El texto nunca sale del servidor en el push.
  event.waitUntil(
    self.registration.showNotification('Nuevo mensaje', {
      body: 'Tienes un mensaje nuevo en el chat.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'private-chat-message',
      renotify: true,
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    (async function () {
      var windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if ('focus' in w) {
          await w.focus();
          return;
        }
      }
      await self.clients.openWindow('/');
    })(),
  );
});
