#!/usr/bin/env python3
"""
Busca fotos que parecen de otro color que el asignado.

Las carpetas del zip dicen el color, pero una foto mal guardada —una remera
verde en la carpeta del gris— no la ve nadie hasta que un cliente pide gris y
mira una foto verde. Mirar novecientas a ojo no es un plan; esto las mide y
separa las pocas que hay que mirar.

Mide el color de la prenda —el pecho en remeras, buzos y camperas; las piernas
en pantalones, shorts y calzas— y lo compara con el resto de las fotos del
mismo color en ese producto. Marca la que queda lejos de las suyas y cerca de
otro color. No corrige nada: arma una planilla para decidir mirando.

Uso: python3 herramientas/fotos/revisar.py CARPETA_PREPARADA [--salida sospechosas.jpg]
"""
import argparse, collections, json, math, os
from PIL import Image, ImageDraw, ImageFont, ImageStat

ABAJO = ('PAN', 'SHO', 'BER')   # SKU que terminan así son de la cintura para abajo


def color_de_prenda(ruta, abajo):
    im = Image.open(ruta).convert('RGB'); im.thumbnail((150, 200))
    w, h = im.size
    caja = (int(w * .33), int(h * .60), int(w * .67), int(h * .85)) if abajo else \
           (int(w * .30), int(h * .30), int(w * .70), int(h * .50))
    return ImageStat.Stat(im.crop(caja)).median   # mediana: una estampa en el pecho no la arrastra


def dist(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def main():
    a = argparse.ArgumentParser(); a.add_argument('carpeta'); a.add_argument('--salida')
    args = a.parse_args()
    m = json.load(open(os.path.join(args.carpeta, 'manifiesto.json'), encoding='utf-8'))
    sospechosas = []
    for sku, fotos in m['productos'].items():
        abajo = sku.upper().endswith(ABAJO)
        for f in fotos:
            f['rgb'] = color_de_prenda(os.path.join(args.carpeta, f['archivo']), abajo)
        grupos = collections.defaultdict(list)
        for f in fotos:
            if f['color']:
                grupos[f['color']].append(f['rgb'])
        centro = {c: [sorted(x[k] for x in v)[len(v) // 2] for k in range(3)] for c, v in grupos.items() if len(v) >= 3}
        for f in fotos:
            if not centro:
                break
            cerca = min(centro, key=lambda c: dist(f['rgb'], centro[c]))
            if f['color'] in centro:
                propia = dist(f['rgb'], centro[f['color']])
                if cerca != f['color'] and propia > 60 and dist(f['rgb'], centro[cerca]) < propia * .55:
                    sospechosas.append((sku, f, cerca))
            elif f['color'] is None and dist(f['rgb'], centro[cerca]) < 28:
                sospechosas.append((sku, f, cerca))   # una general que es igual a un color que se vende
    print(f'{len(sospechosas)} sospechosas')
    for sku, f, sug in sospechosas:
        print(f"  {sku}  {f['archivo']:<28} dice {f['color'] or 'general':<15} parece {sug:<15} ← {f['origen']}")
    if args.salida and sospechosas:
        TW, TH, fila = 120, 160, 8
        im = Image.new('RGB', (fila * (TW + 6) + 6, -(-len(sospechosas) // fila) * (TH + 34) + 6), 'white')
        d = ImageDraw.Draw(im); fnt = ImageFont.load_default(size=11)
        for k, (sku, f, sug) in enumerate(sospechosas):
            x, y = 6 + (k % fila) * (TW + 6), 6 + (k // fila) * (TH + 34)
            t = Image.open(os.path.join(args.carpeta, f['archivo'])); t.thumbnail((TW, TH)); im.paste(t, (x, y))
            d.text((x, y + TH + 2), f"{sku[3:]} {f['color'] or 'gral'}", fill='black', font=fnt)
            d.text((x, y + TH + 16), f'¿{sug}?', fill=(180, 0, 0), font=fnt)
        im.save(args.salida, quality=80); print('planilla:', args.salida)


if __name__ == '__main__':
    main()
