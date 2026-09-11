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
| `MAIL_HOST` `MAIL_PORT` `MAIL_USER` `MAIL_PASS` `MAIL_FROM` | Envío de correo |
| `WHATSAPP_META_TOKEN` `WHATSAPP_META_PHONE_NUMBER_ID` `WHATSAPP_TEMPLATE_NAME` `WHATSAPP_TEMPLATE_LANG` | WhatsApp (opcional) |
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

Fuera de la ventana de 24 horas, Meta sólo entrega **plantillas aprobadas**. Si
`WHATSAPP_TEMPLATE_NAME` está cargado se usa esa plantilla con tres variables
—número de pedido, cliente, total—; si no, se manda texto libre, que llega
mientras haya una conversación abierta.

El WhatsApp **avisa, no adjunta**: la API de Meta manda documentos sólo por URL
pública, y publicar los datos de un cliente en una dirección adivinable para que
WhatsApp la baje es peor que no mandar el adjunto. Los PDF van por mail y se
bajan del panel.

**Si ningún aviso sale, el pedido igual queda guardado.** Se ve en el panel con
la marca «Revisar aviso», y al cliente se le dice la verdad: que el pedido se
recibió, sin afirmar que ya se avisó.

---

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

Hasta **20 por producto**. A cada una se le puede asignar un color, y entonces se
muestra al elegir ese color: la lista ofrece **sólo los colores que ese producto
tiene**, porque con los treinta y seis del catálogo se puede etiquetar la foto de
un pantalón negro como "Salmon" y esa foto no se muestra nunca.

Cada foto tiene además una **miniatura** de 240×320 en WebP —unos 5 KB contra
unos 100 KB de la foto entera—, que usan la tira del panel del producto y la
grilla del admin. Se genera al subir la foto; las que ya estaban se completan
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

## Las pruebas

```bash
npm start          # en una terminal
npm test           # en otra
```

46 comprobaciones contra el servidor levantado. Las que más importan son las
adversarias: qué pasa cuando alguien manda lo que la pantalla no deja mandar
—un precio falso, un SKU de otro producto, cantidades negativas, una cookie de
admin falsificada—.
