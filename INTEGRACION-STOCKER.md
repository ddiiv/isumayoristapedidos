# ISUWAYA MAYORISTA → STOCKER

Contrato de la integración. **El lado de STOCKER ya está hecho** (v3.07 y v3.08):
lo que sigue describe cómo quedó, no cómo se imaginó.

Lo escribió el lado de ISUWAYA leyendo los modelos reales de STOCKER; cada campo
sale ya recortado al largo de la columna a la que va. La primera versión de este
documento proponía reusar la cola de ventas online de Mercado Libre, que aparta
stock y decide sola. **No se hizo así**, y la diferencia importa: un pedido
mayorista se hace a pedido —sin stock— y lo decide una persona.

---

## El circuito

ISUWAYA es el catálogo mayorista; STOCKER es el stock y las ventas:

| Momento en ISUWAYA | Qué hace STOCKER |
|---|---|
| El cliente confirma el pedido | Abre una **solicitud mayorista** en estado *por revisar*. No toca inventario, no numera nada, no aparece en ninguna métrica |
| Mientras la solicitud sigue pendiente | Cada envío reemplaza a la anterior: vale el último. Una entrega vieja que llega tarde se descarta por `secuencia` |
| Alguien la **acepta** en STOCKER | Nace la venta: con el local, el empleado y la caja de quien aprueba, cobrada en el momento o dejada a cobrar en la cuenta corriente |
| Alguien la **rechaza** | Queda rechazada con su motivo. Nunca fue una venta |
| El pedido avanza allá (`enviado`, `entregado`) | Se guarda ese estado y nada más: que el pedido siga su curso no es un cambio del pedido |
| El pedido cambia DESPUÉS de aceptado | La venta no se toca. El cambio se anota y la pantalla lo muestra para que una persona resuelva |
| Se cancela allá antes de revisarla | La solicitud queda cancelada y ya no se puede aceptar |

`evento` viaja y se guarda, pero STOCKER no decide por él: decide por el estado
de la solicitud y por lo que trae el cuerpo. Un pedido puede llegar varias veces
con el mismo evento: ver *Idempotencia*.

### El stock, que es lo que más cambió

STOCKER no aparta nada al recibir. Al aceptar, si no hay stock **avisa cuántas
unidades faltan de cada artículo y no vende**; quien aprueba mira la percha y
confirma. Recién ahí se dan de alta esas unidades y la venta se las lleva. Es el
mismo camino que usa el mostrador cuando la percha tiene algo que el inventario
no, y es lo esperable acá: el pedido mayorista se produce contra el pedido.

---

## La llamada

```
POST  {STOCKER_URL}{STOCKER_RUTA}          por omisión: /integraciones/isuwaya/pedidos
Authorization: Bearer {STOCKER_TOKEN}
Content-Type: application/json
```

- **Token**: uno solo, compartido, que identifica a ISUWAYA. Va en el header, nunca en la URL.
  Lo emite el dueño desde STOCKER (`POST /api/integraciones` con `{"origen":"isuwaya"}`) y **se
  muestra una sola vez**. Emitir uno nuevo apaga el anterior.
- **El `businessId` NO sale del cuerpo**: sale del token. `negocioId` viaja y se ignora, a
  propósito — si el negocio viniera de afuera, una credencial cualquiera podría escribirle ventas a
  otro cliente de STOCKER. `STOCKER_NEGOCIO` queda sólo como referencia.
- **La ruta cuelga de `/api`**: con `STOCKER_RUTA` por omisión, `STOCKER_URL` tiene que terminar en
  `/api` (o poner `STOCKER_RUTA=/api/integraciones/isuwaya/pedidos`).
- **Red**: el backend de STOCKER no tiene dominio público a propósito. Hay dos
  caminos y los dos funcionan con este contrato:
  1. **Mismo proyecto de Railway**: `STOCKER_URL=http://backend.railway.internal:PUERTO`.
     Es lo que mantiene la propiedad de que el backend no se alcanza desde afuera.
     La red privada de Railway resuelve sólo por IPv6 y su DNS tarda unos segundos
     al arrancar: la cola reintenta sola, así que no hace falta nada especial.
  2. **Proyectos distintos**: hay que pasar por el proxy `/api` del frontend
     público (`STOCKER_URL=https://app.eldominio/api`). Es la misma puerta que usa
     el navegador; la ruta tiene que aceptar el token en vez de la cookie de sesión.

### Respuestas que espera ISUWAYA

| Código | Qué entiende ISUWAYA |
|---|---|
| `2xx` | Recibido. No se reintenta |
| `408`, `429`, `5xx` | Problema pasajero: reintenta con espera creciente (30 s → 1 h, hasta 12 intentos) |
| Otro `4xx` | El cuerpo está mal: **no** reintenta, lo deja en error y lo muestra en el panel |

El cuerpo de la respuesta no se usa: alcanza con el código.

---

## El cuerpo

```jsonc
{
  "negocioId": 7,                    // STOCKER_NEGOCIO → businessId
  "plataforma": "isuwaya",           // hay que agregarlo a PLATAFORMAS en colaVentasOnlineService
  "evento": "alta",                  // alta | confirmado | modificado | enviado | entregado | cancelado
  "secuencia": 184,                  // creciente por pedido; descartá una entrega vieja que llegue tarde
  "pedidoExterno": "ISU-000777",     // ≤60 · PedidoPlataforma.pedidoExterno
  "estado": "pendiente",             // el estado en ISUWAYA al momento de mandarlo
  "creadoEn": "2026-09-22T12:00:00.000Z",
  "actualizadoEn": "2026-09-22T13:10:00.000Z",
  "total": 28500,                    // DECIMAL(12,2)
  "unidades": 3,

  "pago": {                          // lo elige el admin al confirmar el stock
    "forma": "Transferencia",        // ≤60 · nombre de PaymentMethod
    "condicion": "contado"           // contado | cuenta_corriente | financiado · Sale.condicionPago
  },

  "comprador": {                     // → PedidoPlataforma
    "nombre": "Boutique Ñandú S.R.L.",  // ≤150 · compradorNombre
    "documento": "27304567894",         // ≤20, sólo números · compradorDocumento
    "email": "compras@nandu.test"       // ≤150 · compradorEmail
  },

  "cliente": {                       // → Client (crear o buscar por cuit)
    "nombre": "Boutique Ñandú S.R.L.",  // ≤100 · Client.nombre
    "apellido": null,                   // ≤100 · razón social: va todo en nombre
    "cuit": "27-30456789-4",            // ≤20 · Client.cuit (con guiones, como se muestra)
    "email": "compras@nandu.test",      // ≤150
    "telefono": "11 5555-1234",         // ≤30
    "whatsapp": "11 5555-1234",         // ≤30 · el mismo, es el único que hay
    "direccion": "Av. San Martín 1847, (entre Belgrano y Rivadavia), Villa Carlos Paz, (5152), Córdoba",  // ≤255
    "tipo": "mayorista"                 // Client.tipo
  },

  "envio": {                         // para Envíos del Día
    "forma": "Expreso Cruz del Sur",    // ≤60 · lo escribe el cliente, puede pasar de 30
    "direccion": "Av. San Martín 1847", // ≤255
    "entreCalles": "Belgrano y Rivadavia",
    "localidad": "Villa Carlos Paz",
    "provincia": "Córdoba",
    "codigoPostal": "5152"
  },

  "items": [                         // → PedidoPlataformaItem
    {
      "sku": "ISUPRU-NEG-M",         // ≤80 · SKU de VARIANTE, el mismo de Stocker
      "cantidad": 3,                 // entero > 0
      "precioUnitario": 9500,        // DECIMAL(12,2) o null
      "producto": "Remera de prueba",// descriptivo, para la pantalla del depósito
      "color": "Negro",
      "talle": "M"
    }
  ]
}
```

### Detalles que importan

- **El SKU es el de la variante.** El pedido de ISUWAYA guarda el SKU del
  producto padre y el detalle por color y talle; la traducción a SKU de variante
  la hace ISUWAYA contra su catálogo, que salió de la misma planilla de STOCKER.
- **Una variante que ya no está** en el catálogo de ISUWAYA viaja como
  `SIN-SKU:<skuAgrupador>:<color>:<talle>`, con la misma idea que usa Jumpseller:
  el pedido queda completo y se ve qué falta identificar, en vez de que
  desaparezca una línea sin que nadie lo note.
- **`envio.forma` puede pasar de 30 caracteres** y `PedidoPlataforma.envioTipo`
  es `STRING(30)`: lo escribe el cliente a mano. Recortalo o guardalo en otro
  campo, pero no lo rechaces por largo.
- **`pago.forma` es texto libre**, elegido de una lista sugerida en el panel de
  ISUWAYA. Si en STOCKER hay que resolverlo contra `PaymentMethod`, conviene
  buscar por nombre y, si no existe, dejarlo anotado sin romper el pedido.

---

## Idempotencia

`(negocio del token, origen, pedidoExterno)` identifica el pedido, y en STOCKER
eso es un índice único de verdad, no un SELECT previo: dos entregas simultáneas
del mismo pedido no pueden crear dos solicitudes. El mismo evento puede llegar más de una vez —la cola
de ISUWAYA reintenta— y **no** tiene que descontar dos veces.

`secuencia` crece en cada envío de ese pedido. Si llega una secuencia menor a la
última procesada, es una entrega vieja que se demoró: descartala.

Cada envío lleva el pedido **entero, como quedó**, no el cambio. Reintentar es
volver a mandar el estado actual.

---

## Variables en ISUWAYA

| Variable | Para qué |
|---|---|
| `STOCKER_URL` | Base del backend. Sin barra final |
| `STOCKER_TOKEN` | El token del header `Authorization` |
| `STOCKER_NEGOCIO` | Referencia nada más: STOCKER saca el negocio del token |
| `STOCKER_RUTA` | Opcional. Por omisión `/integraciones/isuwaya/pedidos` |
| `STOCKER_CADA_MS` | Opcional. Cada cuánto sale la cola (20 s) |
| `STOCKER_TIMEOUT_MS` | Opcional. Cuánto espera cada llamada (15 s) |

Sin las tres primeras, la integración queda apagada: los pedidos se guardan y se
atienden igual en ISUWAYA, y el panel avisa que el stock hay que descontarlo a
mano.

---

## Para probar el otro lado

`pruebas/stocker-de-prueba.cjs` es un STOCKER de mentira que guarda en archivos
todo lo que recibe y puede fallar a pedido:

```bash
node pruebas/stocker-de-prueba.cjs 4599 /tmp/recibidos
FALLAR=500 node pruebas/stocker-de-prueba.cjs      # para probar reintentos
```

`pruebas/stocker.cjs` corre el circuito entero contra él (29 comprobaciones).
