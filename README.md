# ISUWAYA MAYORISTA

Portal de pedidos mayoristas. El cliente recorre el catálogo, arma el pedido por
talle o por curva, y al confirmar salen dos papeles: el **remito A4** con el que
se arma el pedido en el depósito y el **rótulo de 10×15 cm** que se pega en la
bolsa.

No lleva stock. Es un catálogo para tomar pedidos: no valida ni descuenta
existencias, y el precio de cada producto viene de la planilla de STOCKER.

---

## Cómo está armado

Un solo servicio: Express sirve la API y también el frontend. No hay build —el
navegador carga los mismos archivos que están en `public/`—, así que el deploy
es `node server.js` y nada más.

```
server.js            arranque, cabeceras de seguridad, estáticos
src/
  db.js              SQLite y el esquema (se crea solo al arrancar)
  excel.js           importador de la planilla de STOCKER
  pedidos.js         validación del cliente y valorización del pedido
  pdf.js             remito A4 y rótulo 10×15
  notificaciones.js  aviso por mail y por WhatsApp
  rutas/             endpoints públicos y del panel
public/              catálogo (index.html) y panel (admin.html)
pruebas/correr.cjs   la suite de QA
datos/               ← el volumen: base y fotos
```

### Por qué SQLite y no un motor aparte

Todo vive en la carpeta del volumen: la base y las fotos. Un motor externo sumaría
un servicio más que mantener y pagar para un catálogo de cientos de variantes y
unos pocos pedidos por día. Y con el volumen montado, un redeploy no se lleva
nada puesto.

---

## Desplegar en Railway

### 1. El servicio

**New Project → Deploy from GitHub repo** → este repositorio. Railway detecta
Node, instala las dependencias y arranca con `npm start`. No hay paso de build.

### 2. El volumen — lo único que no puede salir mal

Sin volumen, la base y las fotos viven en el disco efímero del contenedor y
**se borran en cada deploy**, sin ningún error que lo avise.

1. En el lienzo del proyecto: **clic derecho → Volume** (o `⌘K` → *Volume*) y
   elegí este servicio.
2. **Mount path: `/data`**. Es una ruta absoluta dentro del contenedor.
   - **Nunca `/app`**: ahí está el código. Un volumen montado en `/app` lo tapa
     entero y la app no arranca (`Cannot find module` en los logs).
3. No hace falta ninguna variable: Railway le pasa a la app
   `RAILWAY_VOLUME_MOUNT_PATH` y la app guarda ahí sola. `DATA_DIR` sólo si
   querés otra carpeta — y si la ponés, que esté **dentro** del volumen.
4. Redeploy. En **Deploy Logs** tiene que decir `datos en /data`.

El volumen se monta al arrancar, no durante el build: por eso la base se crea
en el primer arranque y no antes.

### 3. Las variables

En **Variables** del servicio (`.env.example` las tiene todas comentadas):

| Variable | Para qué |
|---|---|
| `ADMIN_EMAIL` `ADMIN_PASSWORD` | La cuenta del panel. Sin contraseña el panel no abre: no hay valor por defecto a propósito. |
| `PEDIDOS_EMAIL` `PEDIDOS_WHATSAPP` | A dónde llega cada pedido |
| `MAIL_HOST` `MAIL_PORT` `MAIL_USER` `MAIL_PASS` `MAIL_FROM` | Envío de correo. **Sin `MAIL_USER` y `MAIL_PASS` no sale ningún mail**, ni a ISUWAYA ni a los clientes. |
| `WHATSAPP_META_TOKEN` `WHATSAPP_META_PHONE_NUMBER_ID` `WHATSAPP_TEMPLATE_NAME` `WHATSAPP_TEMPLATE_LANG` | Sólo para la API oficial de Meta. El grupo de empleados se vincula desde el panel, sin variables. |
| `SESSION_SECRET` | Opcional. Si no está, la app genera una y la guarda en el volumen. |

**No cargues `PORT` ni `DATA_DIR`.** Si pegás en el editor *Raw* el `.env` de tu
máquina, sacale esas dos líneas: el `PORT` de tu máquina no es el que espera el
dominio de Railway, y el sitio contesta *Application failed to respond* con la
app andando.

### 4. El dominio

**Settings → Networking → Generate Domain**. Si pide un puerto, poné el que
aparece en los logs (`escuchando en el puerto …`).

### 5. La primera carga

**No hay que correr ningún comando.** Las tablas se crean solas en el primer
arranque. Entrá a `/admin.html` con `ADMIN_EMAIL` y `ADMIN_PASSWORD` →
**Catálogo → Traer catálogo de STOCKER** → subí el `.xlsx`. Los colores
repetidos, los talles y las categorías se ordenan solos al importar.

### Si Railway dice «Application failed to respond»

Es un 502: el proxy de Railway no pudo hablar con la app. El motivo está en
**Deployments → el último → Deploy Logs**:

| En los logs | Qué pasa | Qué hacer |
|---|---|---|
| `No puedo escribir en la carpeta de datos` | El volumen está mal montado o sin permisos | Mount path `/data`. Si sigue, variable `RAILWAY_RUN_UID=0` |
| `Cannot find module …` | El volumen está montado en `/app` y tapa el código | Cambiá el mount path a `/data` |
| `escuchando en el puerto X` y el dominio apunta a otro | Hay un `PORT` cargado a mano | Borrá la variable `PORT`, o poné ese mismo puerto en *Networking* |
| `⚠ … NO está dentro del volumen` | `DATA_DIR` apunta afuera del volumen | Borrá `DATA_DIR` |
| `⚠ no hay volumen montado` | No hay volumen | Paso 2 |
| La app arranca bien y se cae sola al rato | Mirá el error de abajo de todo en el log | — |

### Sobre el correo

Con Gmail hay que usar una **contraseña de aplicación**, no la del correo. Se
pega tal cual viene, con espacios: el servidor los saca solo.

### Sobre WhatsApp

Los pedidos nuevos llegan al **grupo de WhatsApp de los empleados**, con el PDF
del pedido. Se vincula desde el panel, en la solapa **Avisos**: se escanea un QR
con el teléfono —como WhatsApp Web— y se elige el grupo.

- **No es la vía oficial de WhatsApp.** Va contra sus condiciones y el número
  puede quedar bloqueado: usá un número aparte, no el principal del negocio.
- **La sesión se guarda en el volumen** (`/data/whatsapp-sesion`): un deploy no
  obliga a escanear de nuevo. Si se desvincula desde el teléfono, la solapa lo
  muestra y hay que volver a escanear.
- **Una sola réplica del servicio.** Dos copias con la misma sesión se echan
  entre sí, y de esa pelea WhatsApp termina sacando el dispositivo del teléfono.
  Para que un deploy no lo provoque —Railway levanta la copia nueva antes de
  bajar la vieja—, el servidor deja un cerrojo con latido en el volumen: la
  copia nueva espera a que la vieja suelte la sesión, y si WhatsApp avisa que
  otra copia la tomó, ésta le cede en vez de disputarla.
- **La sesión tiene respaldo.** La librería guarda las credenciales con una
  escritura común: si el proceso muere justo ahí, el archivo queda cortado y al
  arrancar se crearía una identidad nueva, en silencio, dejando un dispositivo
  fantasma en el teléfono. De cada sesión buena queda un respaldo en la misma
  carpeta y, si el archivo aparece roto, se restaura solo.
- **Si se corta, vuelve solo.** Se reintenta siempre que haya sesión guardada
  —esperando cada vez un poco más, hasta un minuto— y un vigilante revisa cada
  minuto que la conexión siga viva, porque a veces el socket muere sin avisar.
  En la solapa **Avisos** se ve el estado y, si hubo un corte, cuándo fue y por
  qué.
- Si WhatsApp está cortado, el pedido entra igual y el mail sale igual; el
  pedido queda con la marca de que el WhatsApp no salió.

La API oficial de Meta sigue disponible por variables para quien no vincule
nada, pero sólo escribe en grupos creados por ella, de hasta 8 personas y con
una cuenta verificada por Meta.

**Si ningún aviso sale, el pedido igual queda guardado.** Se ve en el panel con
la marca «Revisar aviso», y al cliente se le dice la verdad: que el pedido se
recibió, sin afirmar que ya se avisó.

---

## El circuito de compra

1. **El cliente hace el pedido.** Entra *esperando stock*. A ISUWAYA le llega por
   mail, con el remito y el rótulo, y al grupo de WhatsApp con el remito. Al
   cliente, si dejó su mail, le llega una copia que avisa que falta confirmar el
   stock.
2. **ISUWAYA revisa el stock.** En **Pedidos**, arriba, se ve cuántos esperan
   confirmación. **Revisar stock** abre el pedido renglón por renglón: cada
   casillero arranca en lo pedido y se baja si hay menos (o a cero si no hay).
   - Hay de todo → **Confirmar: hay stock de todo**: queda *confirmado*.
   - Falta algo → **Confirmar con los cambios**: el servidor rearma el pedido con
     lo que hay, lo vuelve a valorizar y queda *modificado*.
   - Para sumar otro artículo o cambiar el precio: **Cambiar artículos o precio**,
     el editor completo. Guardar desde ahí también confirma el pedido.
   - Si no hay nada: volver al pedido y **Marcar cancelado**.
3. **El cliente se entera por mail** en cada uno de esos pasos: se le reenvía el
   pedido como queda, con la nota que se haya escrito y, si hubo cambios, lo que
   cambió renglón por renglón («pediste 4, te mandamos 2») y el total de antes y
   de ahora. Si tiene cuenta, además lo ve en
   **Mis pedidos**.
4. Después, *enviado* y *entregado*, desde el mismo panel.

El mail del cliente es opcional: si no lo deja, sólo se entera en «Mis pedidos»,
y sólo si tiene cuenta. La solapa **Avisos** del panel muestra si el correo está
configurado.

La forma de envío la escribe el cliente —cada uno trabaja con su transporte—,
con un máximo de 60 caracteres para que entre en el rótulo.

### El mínimo de compra

En **Ajustes** se pone el monto que un pedido tiene que alcanzar para poder
confirmarse. En cero no hay mínimo, que es como arranca.

Con un mínimo puesto, el cliente lo ve venir: el botón flotante dice cuánto le
falta mientras recorre el catálogo, y en el carrito aparece un cartel con el
faltante y el mínimo, con **Continuar** apagado hasta que llegue.

El servidor lo exige aparte, con sus propios precios: el carrito que llega lo
puede armar cualquiera desde la consola del navegador, y entre que se arma un
pedido y se confirma puede haber cambiado un precio. Un pedido por debajo del
mínimo vuelve con un 400 y el monto que falta.

Modificar un pedido desde el panel puede dejarlo por debajo del mínimo: falta
stock y se rearma con lo que hay, o se le sacan artículos desde el editor. Ahí
**no se frena**, a propósito — un pedido grande que se achicó por falta de stock
quedaría trabado, sin poder confirmarse ni mandarse. Lo que hace el panel es
avisar: el total estimado se pone en ámbar con cuánto falta, antes de confirmar
pregunta con los dos montos, y el mensaje del final lo recuerda. La decisión es
de quien está mirando el pedido.

## Los clientes

Todo el que confirma un pedido queda en **Clientes**, reconocido por su **CUIT**
—da igual cómo lo escriba, con o sin guiones—:

- **Sin cuenta** queda con su lugar reservado: sus datos guardados y sus compras
  contadas. Si después crea una cuenta con ese CUIT, la cuenta ocupa ese mismo
  lugar y conserva las compras.
- **Con cuenta**, cada pedido hecho con la sesión abierta suma a esa cuenta.
- La ficha de cada cliente muestra sus pedidos, cuánto compró —sin contar los
  cancelados— y **a dónde mandó**, con cuántas veces: el mismo cliente puede
  mandar cada pedido a otro lado.

**Al escribir el CUIT en el pedido**, si ya compró, se completan solos el nombre,
el teléfono y el email. El teléfono y el email llegan **tapados**
(`•• ••••-1234`, `ma•••@gmail.com`): la página es pública y cualquiera puede
escribir un CUIT. Si el cliente los deja así, se usan los guardados; si escribe
otros, los nuevos. La dirección no se completa, porque cambia de pedido en pedido.

Al crear una cuenta con un CUIT que ya compró, en «Mis pedidos» se ven las
compras que dejaron **ese mismo email**: el CUIT de un negocio no es un secreto,
y no alcanza para ver lo que pidió otro.

## El panel

Se entra por la misma puerta que los clientes, en la página principal: el
servidor mira el email y decide el rol. `ADMIN_EMAIL` y `ADMIN_PASSWORD`.

Adentro hay seis secciones:

- **Catálogo** — traer la planilla de STOCKER, y editar cada producto: título,
  precio, categoría, descripción, hasta **20 fotos** (con color asignado, para
  que se muestren al elegirlo) y su **guía de talles**.
- **Colores** — el cuadrito que ve el cliente, elegido con un selector de color.
  Para **unir** dos colores repetidos, se renombra uno con el nombre del otro.
- **Talles** — separados en adulto y niño.
- **Precios en masa** — subir un porcentaje o fijar un precio sobre un filtro
  (categoría, producto, color, talle). Muestra a cuántas variantes toca **antes**
  de aplicar y cuántas cambió después.
- **Pedidos** — el historial completo, con filtros por fecha, estado y cliente,
  los totales de lo filtrado, y el detalle de cada uno con sus dos PDF.
- **Clientes** — quiénes se registraron y activar o desactivar el acceso.

**El catálogo ya no se edita por planilla.** La planilla sirve para TRAER los
productos de STOCKER; de ahí en adelante todo se toca acá, donde se ve el efecto
en el momento. Lo que edites en el panel —fotos, guía, descripción— sobrevive a
la próxima importación; el precio no, porque viene de la planilla.

### Corregir los colores de un producto

En el detalle de cada producto, **Colores de este producto** permite corregir un
color entero —todos sus talles de una vez—:

- **Cambiar** un color por otro: las variantes y sus fotos pasan al nuevo. Si
  el producto ya tiene ese color en alguno de esos talles, se frena para que no
  queden dos variantes del mismo color y talle.
- **Quitar** un color: se van sus variantes y sus fotos pasan a generales. El
  único color de un producto no se quita: para eso está ocultar el producto.
- **Agregar** un color en los talles que se marquen, con el precio que cada
  talle ya tiene en los otros colores.

Todo queda firme aunque se vuelva a importar la planilla de STOCKER: un color
corregido no se pisa y uno quitado no se vuelve a crear.

## Los colores

Son **veinte**, con la ortografía que usa el negocio en STOCKER: `Beish` y no
"Beige", `Melang` y no "Melange", `Bordo` sin tilde. Corregirles la escritura
sería inventar un nombre que no usa nadie, y el día que alguien busque "Beish"
en el panel no lo encuentra.

El catálogo trae además otros dieciséis que no están en esa lista —`Azul
Marino`, `Gris Topo`, `Moliné`…—. **No se unen solos a ninguno de los veinte**:
"Azul Marino" no es "Azul". Quedan marcados en el panel como fuera de la lista
para resolverlos ahí, a la vista.

Los hex son provisorios hasta que se toquen desde el panel: aproximan el nombre
para que la pantalla no arranque en gris.

## Las fotos

**Vertical 3:4**, tipo 1440 × 1920 — la proporción con la que se recortan en el
catálogo y en el panel del producto. Una foto apaisada se recorta arriba y abajo.

Hasta **20 por producto, o cinco por cada color que venda si eso da más** —una
remera en doce colores llega a sesenta—, y **cinco por color** como máximo. A
cada foto se le puede asignar un color, y entonces se muestra al elegir ese
color: la lista ofrece **sólo los colores que ese producto tiene**, porque con
los treinta y seis del catálogo se puede etiquetar la foto de un pantalón negro
como "Salmon" y esa foto no se muestra nunca.

**Se suben de a varias: hasta 30 por tanda.** Se eligen todas juntas en el panel
y entran las que quepan. Las que no entren —porque el producto llegó a su
máximo, porque ese color ya tiene cinco, o porque el archivo no es una imagen de
verdad— se rechazan **una por una, con el motivo**, sin tirar abajo el resto de
la tanda. El panel avisa cuántas entraron y por qué quedaron afuera las otras.

De cada foto se guardan tres versiones: el original, una **miniatura** de 240×320
en WebP —unos 5 KB contra unos 110 KB del original— para las tiras y la fila del
catálogo, y una **mediana** de 720×1080 —unos 34 KB— para la foto grande del
producto y las pantallas densas. Se genera al subir la foto; las que ya estaban se completan
solas al arrancar el servidor, sin correr nada. Si alguna no se pudo generar,
la pantalla usa la foto entera. Al hacerla se abre el archivo, así que lo que
no es una imagen de verdad se rechaza aunque el navegador diga que es un JPG.

## Cargar fotos en masa

Para subir de una vez las fotos de un zip ordenado como
`Categoría/Modelo/Color/fotos`. Hace falta Python 3 con Pillow.

**1. Preparar.** Decide a qué producto y a qué color va cada foto, saca las
repetidas, elige cuáles subir y las achica a 1440×1920 sin los datos internos
del celular (que traen la ubicación donde se sacó la foto):

```bash
python3 herramientas/fotos/preparar.py "MODELO ISU.zip" herramientas/fotos/preparadas --api http://localhost:8090 --por-color 5 --por-producto auto
```

Elige hasta **5 por color**, repartidas a lo largo de la carpeta —las fotos
seguidas de una sesión se parecen—, y hasta **20 por producto**, o 5 por color
si el producto tiene más de cuatro colores. Un color que el producto no vende
va como foto general. Al final lista todo lo que quedó afuera y por qué.

**2. Revisar** (conviene). Marca las fotos que parecen de otro color que el de
su carpeta y arma una planilla para mirarlas:

```bash
python3 herramientas/fotos/revisar.py herramientas/fotos/preparadas --salida sospechosas.jpg
```

**3. Subir.** Entra con la cuenta de admin del `.env` y sube por la misma ruta
que el panel. Si se corta, volver a correrlo sigue donde quedó:

```bash
node herramientas/fotos/subir.cjs herramientas/fotos/preparadas --api https://tu-dominio
```

`--solo SKU,SKU` o `--menos SKU,SKU` para subir una parte.

**El mapa** (`herramientas/fotos/mapa.json`) es donde se deciden los casos que
las reglas no resuelven solas:

| Clave | Para qué |
|---|---|
| `modelos` | Carpeta del modelo → SKU. `null` = todavía no está en el catálogo. |
| `colores` | Carpetas que no son un color oficial (`"PETROLEO": "Aero"`). `"Modelo/carpeta"` gana sobre `"carpeta"`. `null` = foto general. |
| `archivos` | Una foto puntual mal guardada, por su ruta en el zip. `"fuera"` = no se sube. |
| `preferidas` | Carpetas de las que se toman primero (`"bordo bueno"`). |

El servidor también cuida la regla: rechaza la sexta foto de un color, y el
tope del producto es 20 o 5 por color.

## Precios por talle

Del **3XL para arriba** —y el ÚNICO— suele salir más caro porque lleva más tela,
y cuánto más cambia por producto. En el panel de cada producto hay un atajo:
marcar los talles, poner el precio y aplicar. También se puede editar el precio
de una variante suelta en la tabla de abajo.

Vacío quiere decir *seguí el precio del producto*, así que cambiar el precio del
padre le llega a todas las que no tengan uno propio.

## La guía de talles

Es de **cada producto**, no una tabla general: un talle M no mide lo mismo en
una remera que en una campera, y una tabla general sirve para adivinar y no
para decidir antes de pedir cincuenta unidades.

Se carga en el panel eligiendo qué se mide (ancho, largo, lo que sea) y
completando por talle. El cliente la ve con un botón dentro del producto.

## La planilla de STOCKER

Se exporta desde **Stock → Productos → Exportar**. El importador lee las
columnas **por nombre**, no por posición: STOCKER agrega una columna de stock por
cada local, así que las posiciones se corren solas cuando se abre un local nuevo.

De la planilla se usan:

- `SKU Agrupador` — junta las variantes en un producto padre. Es la identidad
  con la que se reimporta, así que **subir la misma planilla dos veces no
  duplica nada**: actualiza.
- `Título`, `Categoría`, `Modelo`, `Género`
- `Precio Mayorista` y `Precio Mayorista Variante` (vacío = hereda del padre)
- `SKU Variante` y los pares `Variante N Nombre` / `Variante N Valor`

Cuál de los dos atributos es el color y cuál el talle se decide por el **nombre**
del atributo, no por el orden. Si los nombres no dicen nada, se cae a la
convención de STOCKER (1 = color, 2 = talle) y el panel lo avisa en el resumen
de la importación en vez de adivinar en silencio.

---

## Qué es una curva

**Una unidad de cada combinación de color y talle que el producto tenga.**

Un producto con 3 colores y 3 talles tiene 9 combinaciones: una curva son 9
unidades, y dos curvas son 18. El modo curva se pide en vista limpia, sin fotos
ni selector de color — elegir un color ahí no significaría nada, porque la curva
los lleva todos.

Los dos modos conviven: se pueden pedir 2 curvas y además 3 remeras sueltas de un
talle. El pedido es la suma.

---

## El diseño

Tema claro con la paleta del logo. Todos los colores salen de las variables de
`:root` en `public/css/estilos.css`; `admin.css` y `seguimiento.css` no definen
colores propios, así que un cambio de tono se hace en un solo lugar.

- **Azul** (`--azul`) para lo que ubica: lo elegido, los precios, la solapa activa.
- **Verde** (`--verde`) sólo para lo que hay que apretar. Si también decorara,
  dejaría de señalar la acción.
- **Petróleo** (`--teal`) para el estado «enviado» y detalles de la marca.
- **El degradé del logo** (`--degrade`) en tres lugares y en ninguno más: la
  franja de arriba, el botón flotante del pedido y la caja del total.
- Ámbar y rojo quedan para lo que pide atención: pedido modificado, cancelado,
  errores.

Todo texto pasa 4,5:1 de contraste contra su fondo y los bordes de los campos
pasan 3:1. Si se cambia un color, conviene volver a medirlo.

Las letras están en `public/fuentes/` —Outfit para títulos y precios,
Instrument Sans para el resto—, cada una con su licencia SIL OFL al lado. Se
sirven desde el sitio porque la política de seguridad no deja cargar fuentes de
afuera, y con caché de un año: si alguna vez se cambia una fuente, tiene que ir
con otro nombre de archivo.

El logo del encabezado y los íconos de la pestaña (`public/img/`) salen del PNG
del logo, recortado. El de 180 px lleva fondo blanco porque iOS no respeta la
transparencia en el ícono de la pantalla de inicio.

El remito y el rótulo usan la misma paleta y el logo (`src/recursos/`), con el
encabezado en blanco: gasta mucho menos tinta que la banda llena de antes, y en
una etiquetadora térmica no sale un rectángulo negro.

### Liviano en el teléfono

- **Todo sale comprimido** (`src/comprimir.js`, sin paquetes de afuera): el
  catálogo pasa de 380 KB a 33 KB, la hoja de estilos de 53 a 12 y los módulos
  del sitio de 91 a 26. Las fotos y los PDF pasan sin tocarse, porque ya vienen
  comprimidos.
- **Cada foto tiene tres versiones**: el original; una miniatura de 240×320
  (unos 5 KB) para las tiras y la fila en pantallas comunes; y una mediana de
  720×1080 (unos 34 KB) para la fila en pantallas densas y la foto grande del
  panel. El original —110 KB en promedio, hasta medio mega— ya no baja en
  ninguna pantalla del cliente. Las versiones de las fotos que ya estaban se
  generan solas al arrancar el servidor, de a una y en segundo plano.
- **En el teléfono no hay efectos caros**: sin el difuminado del encabezado ni
  la luz de fondo, las filas lejos de la pantalla no se dibujan hasta acercarse,
  y las animaciones son cortas, sólo de posición y transparencia, y se apagan si
  el sistema pide menos movimiento.

---

## STOCKER: del pedido a la venta

Los pedidos de ISUWAYA van a STOCKER, que es donde vive el stock y donde se
registran las ventas.

1. **El cliente confirma el pedido** → en STOCKER se abre una **solicitud
   mayorista** en estado *por revisar*. No toca inventario ni numera nada: un
   pedido mayorista se produce contra el pedido, así que no hay nada que apartar.
2. **Se coordina con el cliente y se confirma el stock** → en esa pantalla se
   elige **cómo se pagó**, que es el momento en que se sabe. Mientras la
   solicitud siga pendiente, cada cambio de acá la reemplaza: vale el último.
3. **Alguien la acepta en STOCKER** → ahí nace la venta, con su cliente y su
   forma de pago, cobrada o dejada en cuenta corriente. Si falta stock, STOCKER
   avisa cuántas unidades faltan y no vende hasta que quien aprueba lo confirme
   mirando la percha.

Cancelar antes de que la revisen deja la solicitud cancelada. Si el pedido
cambia después de aceptado, la venta no se toca: el cambio se anota allá para
que una persona lo resuelva.

**El pedido del cliente no depende de STOCKER.** Si STOCKER está caído, el
pedido se guarda y se atiende igual: cada cambio queda en una cola
(`stocker_cola`) que reintenta sola, esperando cada vez un poco más, hasta un
día y medio. Un cuerpo que STOCKER rechaza con 4xx no se reintenta para siempre:
queda en error, se ve en el panel → **Avisos** y hay un botón para volver a
mandarlo. Cada envío lleva el pedido entero, así que reintentar es volver a
mandar el estado actual: no importa cuántas veces llegue ni en qué orden.

La traducción que hace ISUWAYA: el pedido guarda el SKU del producto padre con
el detalle por color y talle, y STOCKER trabaja por **SKU de variante**. Esa
resolución se hace contra el catálogo —que salió de la misma planilla de
STOCKER— al momento de mandar.

**Lo que no se muestra en el panel**: ni la dirección de STOCKER ni el número de
negocio. El panel se abre desde cualquier computadora y termina en capturas de
pantalla, y el backend de STOCKER no tiene dominio público justamente para que
no se sepa dónde golpear. Cualquier dirección que aparezca dentro de un mensaje
de error se reemplaza por la palabra STOCKER antes de guardarla.

**Ojo con el `/api`**: la ruta de STOCKER cuelga de ahí, así que `STOCKER_URL`
tiene que terminar en `/api` (o hay que poner la ruta completa en
`STOCKER_RUTA`). Si no, STOCKER contesta 404 y el panel lo dice con esa pista.

El contrato completo —campos, largos, eventos, idempotencia y las dos formas de
conectar en Railway— está en **`INTEGRACION-STOCKER.md`**.

---

## La medición del tráfico

Qué se mira en la tienda, para poder ordenar el catálogo con eso en vez de a mano.

**Qué se guarda.** Un evento por gesto: catálogo abierto, categoría abierta, fila
vista (un segundo en pantalla), ficha abierta, click, producto agregado al
carrito, carrito abandonado y pedido confirmado. Cada uno lleva el producto o la
categoría, la fecha y un identificador al azar de la visita, que vive en la
pestaña y se borra al cerrar el navegador. Si quien mira ya entró con su cuenta
queda también su ficha de cliente; si no, es anónimo. **No se guarda la IP ni el
navegador.** Los eventos se borran solos a los seis meses.

Los eventos de un cliente identificado son datos personales (Ley 25.326): si
alguna vez se usan para algo más que ordenar el catálogo, hay que decirlo en la
página.

**Cómo se ordena el catálogo.** Cada producto suma, de los últimos 30 días:

| Gesto | Puntos |
|---|---|
| La fila quedó a la vista | 1 |
| Click en el producto | 2 |
| Ficha abierta | 4 |
| Agregado al carrito | 8 |
| Cada pedido en el que apareció | 10 |
| Tamaño de lo pedido | raíz de las unidades × 2 |

Las unidades van amortiguadas a propósito: un mayorista que se lleva novecientas
unidades de un producto en un solo pedido no lo vuelve el más buscado del
catálogo, y contándolas derecho ese producto quedaba clavado primero un mes.
El `orden` manual del panel sigue existiendo y queda como desempate. La cuenta se
rehace como mucho cada cinco segundos.

**«Productos Nuevos» es un filtro por fecha de alta, no una categoría.** El
producto sigue estando en Remeras y además aparece ahí durante 30 días. La fecha
la pone la plataforma al importar (`productos.creado_en`); lo que se cargó antes
de esta versión no tiene fecha y **no** figura como nuevo: no se le inventa una.
Como la fecha de alta no dice si el modelo es nuevo o si estaba hace años en el
negocio y recién se cargó, eso se marca a mano en el panel → Tráfico.

**El reporte** está en el panel → Tráfico: visitas, fichas abiertas, clicks,
conversión, carritos abandonados con la plata que quedó sin pedir, el ranking de
productos con el mismo puntaje que ordena la tienda, y la lista de altas
recientes.

---

## Las pruebas

```bash
npm start          # en una terminal
npm test           # en otra
```

46 comprobaciones contra el servidor levantado. Las que más importan son las
adversarias: qué pasa cuando alguien manda lo que la pantalla no deja mandar
—un precio falso, un SKU de otro producto, cantidades negativas, una cookie de
admin falsificada—.

### Las otras suites

- `pruebas/pdf.cjs` — el remito y el rótulo, midiendo que nada se salga del
  papel ni quede encimado. No necesita el servidor.
- `pruebas/whatsapp.cjs` — el aviso al grupo de WhatsApp, con un WhatsApp de
  mentira. No necesita el servidor.
- `pruebas/panel.cjs` — seguimiento, estadísticas, colores y el circuito de
  compra. **Escribe pedidos y reimporta la planilla**: correla contra una copia
  de la base. Los avisos por mail se prueban con un correo de prueba que guarda
  los mails en una carpeta en vez de mandarlos:

  ```bash
  cp -r datos /tmp/copia
  node pruebas/correo-de-prueba.cjs 2526 /tmp/correos &
  DATA_DIR=/tmp/copia PORT=8091 MAIL_HOST=127.0.0.1 MAIL_PORT=2526 MAIL_USER=x MAIL_PASS=x PEDIDOS_EMAIL=pedidos@prueba.test node server.js &
  API=http://localhost:8091 CORREOS=/tmp/correos PEDIDOS_EMAIL=pedidos@prueba.test node pruebas/panel.cjs
  ```
