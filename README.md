# Zapatillas y calzado deportivo · Competencia · Lima

Panel interno de precios basado en observación real. Lee solo lo que las tiendas publican hoy en sus sitios (no captura manual, no estima, no completa con terceros). Es 100 % config-driven: `config.json` define fuentes/adaptadores/textos/tramos/segmentos; `scripts/actualizar.mjs` genera `data.json`; `index.html` consume `data.json` y permite filtrar/descargar CSV.

## Objetivo
Replicar el enfoque de `electro-competencia` para el rubro **Zapatillas y calzado deportivo (Lima)**: motor reutilizable, una única fuente de verdad en config, datos observados y panel confiable con trazabilidad por fuente/lectura.

## Estructura
```
zapatillas-competencia/
├── config.json
├── data.json
├── index.html
├── README.md
└── scripts/
    ├── actualizar.mjs
    └── servir.mjs
```

## Fuentes observadas (lectura 08 oct. 2026)
| Tienda | Plataforma | Adaptador | Estado | Modelos con precio | Notas |
|---|---|---|---|---|---|
| Marathon | SAP Commerce (Hybris) | `hybris-grid` | OK | 601 | Grid server-side: bloques `.product-item` con `data-product-info` (name,id,price,brand,category,variant,position). **Requiere el parámetro `device=DESKTOP`**: sin él, las URLs con query devuelven una página de redirección en vez del grid. Precios en S/. Sin precio tachado visible en listado. Paginación `?device=DESKTOP&q=%3Arelevance&page=N` (N=0 primera página). |
| Triathlon | VTEX | `vtex` (`searchSub: "/f"`, catIds: [3,34,59]) | OK | 149 | API `/api/catalog_system/pub/products/search/f/`. Árbol: Hombre 3, Kids 34, Mujer 59. |
| Oechsle | VTEX | `vtex` (`catIds: [1223006]`) | OK | 521 | Categoría Zapatillas (1223006) con ramas Mujer/Hombre/Niños. La API devuelve páginas parciales antes del final; se pagina hasta respuesta vacía. |
| Sodimac | (no habilitado) | — | sin catálogo | 0 | No se detectó listado de zapatillas apto para lectura; marcado sin catálogo. |
| Promart | (no habilitado) | — | sin catálogo | 0 | Sin catálogo de zapatillas observado. |
| Falabella | (no habilitado) | — | sin catálogo | 0 | Sin catálogo de zapatillas observado. |
| Plaza Vea | (no habilitado) | — | sin catálogo | 0 | Búsquedas de zapatillas devuelven `[]`/400; sin catálogo utilizable. |
| Ripley | (no habilitado) | — | caída (403) | 0 | HTTP 403 a bots; no leído. |
| Ishop | (no habilitado) | — | caída (503) | 0 | HTTP 503 a bots; no leído. |

**Cobertura:** 1271 modelos con precio · 7/9 fuentes leídas · 3/9 con catálogo.

## Motor y adaptadores
- `scripts/actualizar.mjs` lee `config.json`, normaliza, aplica FX (open.er-api.com), clasifica `segmento` por `config.segmentos` (patrones sobre `p.categoria || p.nombre`, NFD normalize), calcula tramos y escribe `data.json`.
- `leerHybrisGrid(url, opts)`: parsea grid Hybris (Marathon). Extrae URL, imagen, marca, categoría tienda, precio, precio tachado si existe (no presente en Marathon), SKU/posición. Paginación configurable con `device` (por defecto `DESKTOP`) y `paginasMax`.
- `leerVtex(url, opts)`: soporta `catIds` (array) y `searchSub` (`"/f"` para VTEX con subpath). Usa `specificationFilters` cuando aplica; base URL real por tienda. Pagina avanzando por el tamaño real recibido y corta solo con respuesta vacía (VTEX puede devolver páginas parciales antes del final).
- Política de lectura: **sin inventar plataformas ni datos**. Si fuente cae o no devuelve catálogo, se marca `vacio`/error y no se completa.

## Configuración
`config.json` controla:
- `fuentes[]`: `id`, `nombre`, `plataforma`, `url`, `adaptador`, `activo`, `paginacion`, `catIds`/`searchSub` si aplica, `selectorGrid`, `campos`, `envio`.
- `moneda`: FX PEN/USD (actualizado al leer).
- `tramos`: etiquetas para distribución por rango.
- `segmentos`: patrones para clasificar `hombre|mujer|ninos|sin-segmento` (usa `categoria` primero).
- `exportacion.columnas`: 11 columnas para CSV (incluye `Segmento` y `Categoría tienda`).

## Panel (index.html)
- 100 % config-driven (lee `data.json`). Filtros: búsqueda, Tienda, **Segmento** (`#f-segmento`: Todas/Hombre/Mujer/Niños), Tramo, Ordenar por, Solo disponibles.
- Métricas: modelos con precio, mediana, rango min–máx, % con precio tachado, fuentes leídas, envío gratis.
- Gráficas/leyendas: rango por tienda (eje al P95), distribución por tramos.
- Tabla envíos: política pública por tienda (enlace), marca OK/fuente caída, fecha verificada.
- CSV: descarga alineada a 11 columnas con `Segmento`, `Categoría tienda`, `URL`, `Fecha lectura`.

## Cómo usar
```bash
# Generar/actualizar data.json desde config
node zapatillas-competencia/scripts/actualizar.mjs

# Servir panel local
node zapatillas-competencia/scripts/servir.mjs
# abrir http://127.0.0.1:8788/
```

## Segmentación
`segmento` asignado post-FX con reglas en `config.segmentos`:
- hombre: patrones `hombre`, `men`, `masculino`, `boy`, `junior`, `infante`, `caballero`
- mujer: `mujer`, `women`, `femenino`, `girl`, `dama`, `niña`
- ninos: `niño`, `niños`, `kids`, `infantil`, `bebe`, `bebé`, `toddler`

Resultado actual: hombre 949, mujer 169, ninos 149, sin-segmento 4.

## Limitaciones reales
- Solo se incluyen productos con **precio publicado** visible (no se inventan faltantes).
- Marathon sin precio tachado en listado (no reportado).
- Ripley (403) e Ishop (503) no leídos por bloqueo a bots.
- Plaza Vea devuelve vacío/400 para búsquedas de zapatillas.
- Sodimac/Promart/Falabella sin catálogo de zapatillas detectado en esta corrida.
- Envíos: `No observado` (no extraídos de ficha por ahora) con enlace a política pública.
- Datos observados el 09 oct. 2026 09:41 (hora Lima). Requiere lectura diaria.
- Cálculos propios (mediana, tramos, P95) con datos observados.