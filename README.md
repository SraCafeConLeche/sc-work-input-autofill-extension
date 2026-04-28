# Work Input Autofill Extension

Extension Chrome Manifest V3 para guardar, administrar y autorellenar inputs laborales por sitio y ruta.

## Caracteristicas

- Guarda automaticamente valores de `input`, `textarea` y `select` permitidos.
- Evita guardar borradores parciales mientras escribes; guarda al confirmar o salir del campo.
- Separa datos por `origin + pathname`, por ejemplo `https://empresa.cl/clientes`.
- Autorellena campos guardados al cargar la pagina.
- Muestra sugerencias automaticas al hacer click o focus en un campo con valores guardados.
- Ordena las sugerencias por uso frecuente y permite eliminar resultados desde el menu.
- Permite editar, activar, desactivar y eliminar campos desde el popup.
- Muestra el historial de valores guardados dentro de cada campo autoguardado.
- Permite crear reglas manuales con `label`, `CSS selector`, `value`, `enabled`, `createdAt` y `updatedAt`.
- Escanea inputs visibles y seguros de la pagina actual para convertirlos en reglas manuales.

## Instalacion en Chrome

1. Abre `chrome://extensions`.
2. Activa `Developer mode`.
3. Haz clic en `Load unpacked`.
4. Selecciona la carpeta local del proyecto.
5. Abre una pagina `http` o `https`, escribe en campos permitidos y abre el popup de la extension.

## Seguridad

La extension guarda datos solo en `chrome.storage.local` y no usa backend ni servicios externos.

No guardes contrasenas, tokens, codigos 2FA, datos bancarios, tarjetas, CVV, archivos ni informacion sensible. Por defecto se bloquean inputs `password`, `hidden`, `file`, `submit`, `button`, `reset`, `checkbox` y `radio`, ademas de campos con palabras sensibles como `token`, `secret`, `credit`, `card`, `cvv`, `2fa`, `otp`, `pin`, `bank` y `banco`.

La extension tiene dos modos:

- `Seguro`: modo por defecto. Mantiene bloqueados los campos sensibles y tipos de input riesgosos.
- `Permisivo`: permite campos que normalmente estarian bloqueados y muestra una advertencia al activarlo. Este modo puede guardar datos sensibles en `chrome.storage.local`; usalo solo si entiendes el riesgo.

Los inputs `file` no pueden autorellenarse con rutas de archivo por restricciones de Chrome, incluso en modo permisivo.

## Uso de reglas manuales

1. Entra a la pagina donde quieres rellenar un campo.
2. Abre el popup.
3. Haz clic en `Escanear inputs`.
4. Usa un input detectado o escribe una regla manual:
   - `Label`: nombre visible para reconocer la regla.
   - `CSS selector`: selector del campo, por ejemplo `#clientName`.
   - `Value`: valor que se asignara al campo.
   - `Enabled`: permite activar o pausar la regla.
5. Guarda la regla y usa `Rellenar ahora`.

## Autocompletado automatico

Cuando haces click o focus en un campo permitido, la extension busca valores guardados para ese mismo selector en la pagina actual. Si encuentra valores, muestra un menu junto al campo para seleccionar uno.

Las opciones salen desde:

- El ultimo valor autoguardado para ese campo.
- El historial reciente del campo, hasta 10 valores.
- Reglas manuales habilitadas que apunten al mismo selector.

Las reglas manuales siempre se muestran en el autocompletado y no cuentan contra el limite de valores autoguardados.

Al seleccionar una opcion, la extension asigna el valor, aumenta un contador interno no visible y dispara eventos `input` y `change` para compatibilidad con apps React, Angular, Vue y formularios comunes.

Cada sugerencia tiene una `x` para eliminarla. Si eliminas una sugerencia autoguardada, se borra solo ese valor del historial del campo. Si eliminas una sugerencia que viene de una regla manual, se elimina esa regla manual.

El historial mantiene un maximo de 10 valores por input. Cuando se supera ese limite, la extension conserva los mas usados y va descartando los menos usados.

## Estructura

```text
manifest.json
src/
  background.js
  content.js
  popup.css
  popup.html
  popup.js
  storage.js
```

