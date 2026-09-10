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

1. **Creá el servicio** apuntando a este repositorio. Railway detecta Node y
   corre `npm start`.

2. **Montá un volumen** y poné el punto de montaje en `/data`.
   Es lo único que hay que hacer bien: sin volumen, la base y las fotos viven en
   el disco efímero del contenedor y **se pierden en cada deploy**.

3. **Cargá las variables** (`.env.example` las tiene todas):

   | Variable | Para qué |
   |---|---|
   | `DATA_DIR` | `/data` — la carpeta del volumen |
   | `ADMIN_PASSWORD` | Sin esto el panel no abre. No tiene valor por defecto a propósito. |
   | `PEDIDOS_EMAIL` | A dónde llega cada pedido con los PDF adjuntos |
   | `PEDIDOS_WHATSAPP` | A qué número llega el aviso |
   | `MAIL_HOST` `MAIL_PORT` `MAIL_USER` `MAIL_PASS` `MAIL_FROM` | Envío de correo |
   | `WHATSAPP_META_TOKEN` `WHATSAPP_META_PHONE_NUMBER_ID` | WhatsApp (opcional) |
   | `WHATSAPP_TEMPLATE_NAME` `WHATSAPP_TEMPLATE_LANG` | Plantilla aprobada de Meta |

   `PORT` la pone Railway sola.

4. **Entrá al panel** en `/admin.html` y subí la planilla.

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
