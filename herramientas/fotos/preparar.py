#!/usr/bin/env python3
"""
Prepara las fotos de un zip de modelos para subirlas al catálogo.

El zip viene como lo arma el negocio: Categoría/Modelo/Color/fotos. Este script
decide a qué producto y a qué color va cada foto, saca las repetidas, elige
cuáles subir respetando los topes, y las achica al tamaño de trabajo del
portal. No sube nada: deja una carpeta lista y un manifiesto que lee subir.cjs.

Separarlo en dos pasos es a propósito. Preparar se hace una vez y se revisa
mirando la carpeta; subir se repite contra cada servidor —la copia local
primero, Railway después— con exactamente las mismas fotos.

Uso:
  python3 herramientas/fotos/preparar.py ZIP SALIDA --api http://localhost:8090 \\
      [--mapa herramientas/fotos/mapa.json] [--por-color 5] [--por-producto 20|auto]

  --por-producto auto: 20, o 5 por color si el producto tiene tantos colores con
  fotos que no entran en 20.
"""
import argparse, collections, datetime, hashlib, io, json, os, subprocess, urllib.request, zipfile
from PIL import Image, ImageOps

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LADO = (1440, 1920)   # 3:4, el tamaño de las fotos de producción
EXTENSIONES = ('.jpg', '.jpeg', '.png', '.webp')


def canonicos(nombres):
    """
    Los nombres de carpeta pasan por las MISMAS reglas de color que el portal.

    Se le pregunta a src/colores.js en vez de copiar el mapa acá: dos copias de
    "moline es melang" terminan diciendo cosas distintas el día que alguien
    toca una sola.
    """
    codigo = ("const {canonico,esOficial}=require('./src/colores');"
              "const n=JSON.parse(require('fs').readFileSync(0,'utf8'));const m={};"
              "for(const c of n){const k=canonico(c);m[c]=esOficial(k)?k:null}"
              "process.stdout.write(JSON.stringify(m))")
    r = subprocess.run(['node', '-e', codigo], input=json.dumps(sorted(nombres)),
                       capture_output=True, text=True, cwd=RAIZ, check=True)
    return json.loads(r.stdout)


def parejas(lista, k):
    """
    k fotos repartidas a lo largo de la carpeta, no las k primeras.

    Las fotos de una sesión vienen en el orden en que se sacaron: las primeras
    cinco suelen ser la misma pose con un paso de diferencia. Tomando una cada
    tanto aparecen el frente, la espalda y el detalle.
    """
    if k <= 0:
        return []
    if k >= len(lista):
        return list(lista)
    if k == 1:
        return [lista[0]]
    return [lista[round(i * (len(lista) - 1) / (k - 1))] for i in range(k)]


def elegir(candidatas, k, preferidas):
    """Primero las de las carpetas preferidas ("bordo bueno"), después el resto."""
    buenas = [f for f in candidatas if f['carpeta'] in preferidas]
    resto = [f for f in candidatas if f['carpeta'] not in preferidas]
    tomadas = parejas(buenas, k)
    return tomadas + parejas(resto, k - len(tomadas))


def turnos(grupos):
    """Una de cada grupo por vuelta: el carrusel de "todas" arranca mostrando todos los colores."""
    salida, i = [], 0
    while any(i < len(g) for g in grupos):
        salida += [g[i] for g in grupos if i < len(g)]
        i += 1
    return salida


def main():
    a = argparse.ArgumentParser(description='Prepara las fotos de un zip para el catálogo.')
    a.add_argument('zip'); a.add_argument('salida')
    a.add_argument('--api', required=True, help='de dónde se lee el catálogo: http://localhost:8090 o la URL de Railway')
    a.add_argument('--mapa', default=os.path.join(RAIZ, 'herramientas', 'fotos', 'mapa.json'))
    a.add_argument('--por-color', type=int, default=5)
    a.add_argument('--por-producto', default='20')
    a.add_argument('--sin-conjuntos', action='store_true', help='saltear las fotos que están en más de un producto')
    args = a.parse_args()

    mapa = json.load(open(args.mapa, encoding='utf-8'))
    modelos, colores_mapa = mapa['modelos'], mapa['colores']
    preferidas = set(mapa.get('preferidas', []))
    por_archivo = mapa.get('archivos', {})
    catalogo = {p['sku']: p for p in json.load(urllib.request.urlopen(args.api.rstrip('/') + '/api/catalogo'))['productos']}
    z = zipfile.ZipFile(args.zip)

    # ── 1. qué es cada foto ──────────────────────────────────────────
    fotos = []
    for i in z.infolist():
        if i.is_dir() or not i.filename.lower().endswith(EXTENSIONES):
            continue
        p = i.filename.split('/')
        if len(p) < 3:
            continue   # suelta en la raíz o en una categoría: no hay modelo al que asignarla
        modelo = p[1]
        carpeta = p[2] if len(p) >= 4 else None   # Akil/negro/CORTO/… sigue siendo negro
        if carpeta:
            carpeta = carpeta.split('(')[0].strip()   # "Monaco-Mostaza (debería ser amarillo…)"
            if carpeta.lower().startswith(modelo.lower() + '-'):
                carpeta = carpeta[len(modelo) + 1:].strip()   # "Comfort-Azul" → "Azul"
        fotos.append(dict(ruta=i.filename, modelo=modelo, carpeta=carpeta))

    canon = canonicos({f['carpeta'] for f in fotos if f['carpeta']})
    afuera = collections.Counter()
    por_producto = collections.defaultdict(list)
    for f in fotos:
        if f['modelo'] not in modelos:
            afuera[f"modelo sin mapa: {f['modelo']}"] += 1; continue
        sku = modelos[f['modelo']]
        if sku is None:
            afuera[f"sin producto en el catálogo: {f['modelo']}"] += 1; continue
        if sku not in catalogo:
            afuera[f"{sku} no está en {args.api}"] += 1; continue
        # Una foto puntual mal guardada se corrige por su ruta, sin tocar el resto de la carpeta.
        if f['ruta'] in por_archivo:
            if por_archivo[f['ruta']] == 'fuera':
                afuera['sacada a mano en el mapa'] += 1; continue
            color = por_archivo[f['ruta']]
        elif f['carpeta'] is None:
            color = None
        else:
            especifica = f"{f['modelo']}/{f['carpeta']}"
            if especifica in colores_mapa:
                color = colores_mapa[especifica]
            elif f['carpeta'] in colores_mapa:
                color = colores_mapa[f['carpeta']]
            elif canon.get(f['carpeta']):
                color = canon[f['carpeta']]
            else:
                afuera[f"color sin decidir: {f['modelo']}/{f['carpeta']}"] += 1; continue
        f['sku'], f['color'] = sku, color
        por_producto[sku].append(f)

    # ── 2. sin repetidas, y cuáles van ───────────────────────────────
    md5 = lambda ruta: hashlib.md5(z.read(ruta)).hexdigest()
    for f in fotos:
        if 'sku' in f:
            f['md5'] = md5(f['ruta'])
    en_productos = collections.defaultdict(set)
    for f in fotos:
        if 'sku' in f:
            en_productos[f['md5']].add(f['sku'])

    plan, reporte = {}, {}
    for sku, lista in sorted(por_producto.items()):
        producto = catalogo[sku]
        vende = [c['nombre'] for c in producto['colores']]
        vistas, coloreadas, generales = set(), collections.defaultdict(list), collections.defaultdict(list)
        for f in sorted(lista, key=lambda x: x['ruta']):
            if f['md5'] in vistas:
                afuera['repetida en la misma carpeta'] += 1; continue
            if args.sin_conjuntos and len(en_productos[f['md5']]) > 1:
                afuera['foto de conjunto (salteada)'] += 1; continue
            vistas.add(f['md5'])
            # Un color que el producto no vende va como foto general: se ve en "todas" y no en el filtro.
            if f['color'] in vende:
                coloreadas[f['color']].append(f)
            else:
                generales[f['carpeta'] or ''].append({**f, 'color': None})

        orden = [c for c in vende if c in coloreadas]
        necesita = sum(min(args.por_color, len(coloreadas[c])) for c in orden)
        tope = max(20, necesita) if args.por_producto == 'auto' else int(args.por_producto)

        # Una por color por vuelta: si no entran todas, cada color queda con la misma cantidad.
        cupo, libres = {c: 0 for c in orden}, tope
        while libres > 0:
            avanzo = False
            for c in orden:
                if libres and cupo[c] < min(args.por_color, len(coloreadas[c])):
                    cupo[c] += 1; libres -= 1; avanzo = True
            if not avanzo:
                break
        de_color = [elegir(coloreadas[c], cupo[c], preferidas) for c in orden]
        gen = turnos([parejas(g, len(g)) for _, g in sorted(generales.items())])[:libres]
        plan[sku] = turnos(de_color) + gen
        reporte[sku] = dict(tope=tope, necesita=necesita,
                            colores={c: cupo[c] for c in orden}, generales=len(gen),
                            generales_disponibles=sum(len(g) for g in generales.values()))

    # ── 3. achicar y escribir ────────────────────────────────────────
    os.makedirs(args.salida, exist_ok=True)
    manifiesto = dict(generado=datetime.datetime.now().isoformat(timespec='seconds'), api=args.api,
                      por_color=args.por_color, por_producto=args.por_producto, productos={}, afuera=dict(afuera))
    total = 0
    for sku, elegidas in plan.items():
        os.makedirs(os.path.join(args.salida, sku), exist_ok=True)
        manifiesto['productos'][sku] = []
        for n, f in enumerate(elegidas, 1):
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(z.read(f['ruta'])))).convert('RGB')
            im.thumbnail(LADO, Image.LANCZOS)   # achica sin agrandar ni recortar
            nombre = f"{n:02d}-{(f['color'] or 'general').replace(' ', '-')}.jpg"
            # Sin EXIF: una foto de celular trae la ubicación de donde se sacó.
            im.save(os.path.join(args.salida, sku, nombre), 'JPEG', quality=82, optimize=True, progressive=True)
            manifiesto['productos'][sku].append(dict(archivo=f'{sku}/{nombre}', color=f['color'], origen=f['ruta'], md5=f['md5']))
            total += 1
    manifiesto['reporte'] = reporte
    json.dump(manifiesto, open(os.path.join(args.salida, 'manifiesto.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    print(f'{total} fotos listas en {args.salida}, para {len(plan)} productos\n')
    for sku, r in reporte.items():
        marca = f"  ← tope {r['tope']}" if r['tope'] > 20 else ''
        cols = ', '.join(f'{c} {n}' for c, n in r['colores'].items())
        de = f" (de {r['generales_disponibles']})" if r['generales_disponibles'] > r['generales'] else ''
        print(f"  {sku:<11} {sum(r['colores'].values()):>2} de color ({cols}) + {r['generales']} generales{de}{marca}")
    print('\nquedaron afuera:')
    for k, n in sorted(afuera.items()):
        print(f'  {n:5d}  {k}')


if __name__ == '__main__':
    main()
