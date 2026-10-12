# Temas y personalización

Once adaptaciones de paletas existentes para el chat. Se conservan sus colores de fondo y acento, asignándolos a superficies, texto, burbujas y acciones. GitHub Light es la opción neutra por defecto.

| Temas | Fuente original |
| --- | --- |
| GitHub Light y GitHub Dark | [GitHub Primer Primitives](https://github.com/primer/primitives) |
| Catppuccin Latte y Catppuccin Mocha | [Catppuccin: paletas oficiales](https://github.com/catppuccin/catppuccin#-palette) |
| Dracula | [Dracula: especificación](https://draculatheme.com/spec) |
| Nord | [Nord: colores y paletas](https://www.nordtheme.com/docs/colors-and-palettes/) |
| Solarized Light y Solarized Dark | [Solarized, Ethan Schoonover](https://ethanschoonover.com/solarized/) |
| Gruvbox Dark | [Gruvbox](https://github.com/morhetz/gruvbox) |
| Tokyo Night | [Tokyo Night](https://github.com/folke/tokyonight.nvim) |

Los colores funcionales de lectura, peligro y texto secundario se ajustan cuando la paleta original no alcanza 4.5:1 en las superficies del chat. No son paquetes oficiales de estas marcas ni cambios en la identidad de la app.

`apps/web/src/themes.css` contiene las once paletas mediante variables CSS y selectores `data-theme`. Cocoa es la opción inicial para el rol member; una preferencia guardada por esa cuenta tiene prioridad. No requiere estilos inline, fuentes externas ni dependencias nuevas. Los componentes usan colores semánticos, incluidos texto de botones y diálogos de peligro en temas oscuros.

La preferencia usa la clave `private-chat:theme:<userId>` en localStorage y sólo almacena el identificador del tema. No contiene credenciales, tokens, nombres, fotos ni mensajes. Es local a la cuenta y al navegador: no se sincroniza entre dispositivos. Si el almacenamiento está bloqueado, la selección funciona durante la sesión; si el valor guardado no existe, se usa GitHub Light.

El nombre y el avatar siguen guardándose por las rutas existentes del contrato, con cookies y CSRF. Las cuentas de las pruebas usan exclusivamente nombres y datos sintéticos.

La foto seleccionada usa una URL blob local, revocada al reemplazar la selección o cerrar la vista. Guardar queda deshabilitado hasta que el navegador decodifique la imagen. Cancelar no sube ni guarda archivos. Un error del servidor conserva la selección para permitir reintentar. La CSP existente admite imágenes blob y sigue prohibiendo scripts y estilos inline.

## Área superior de iPhone

La cabecera usa `--color-surface`. `useTheme` aplica `data-theme` y lee ese mismo token CSS para actualizar `meta[name="theme-color"]` antes de pintar. Esto cubre las once paletas, la selección manual y la preferencia guardada sin duplicar los colores en TypeScript. HTML y body también usan esa superficie en los bordes del viewport; `#root` conserva el fondo de contenido `--color-canvas`.

HTML y manifest arrancan con `#ffffff`, superficie del tema inicial GitHub Light. Se conservan `viewport-fit=cover`, la separación de la cabecera mediante `env(safe-area-inset-top)` y el estilo de status bar `default`. La documentación de [WebKit sobre Safari 15](https://webkit.org/blog/11989/new-webkit-features-in-safari-15/) describe `theme-color` para la barra de estado y overscroll; [Apple documenta los estilos de status bar](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html). El acabado que aplica iOS debe comprobarse en un iPhone real, tanto desde el icono de inicio como en Safari.
