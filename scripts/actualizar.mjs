// Motor de lectura diaria de precios de competencia — genérico por industria.
// Node >= 20, sin dependencias externas.
// Lee config.json (única fuente de verdad) y genera data.json en la raíz del repo.
// El panel (index.html) carga data.json y se configura a sí mismo con el config embebido.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(DIR, '..');
const DATA = path.join(RAIZ, 'data.json');
const CFG = JSON.parse(await readFile(path.join(RAIZ, 'config.json'), 'utf8'));

const { monedaLocal, monedaExtranjera } = CFG;
const COD_LOC = monedaLocal.codigo;
const COD_EXT = monedaExtranjera.codigo;

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
let UA_ACTUAL = UA_CHROME;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const escRg = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uaDe = (f) => (f?.ua === 'edge' ? UA_EDGE : UA_CHROME);

async function pedirGrande(url, tipo = 'text', timeoutMs = 30000) {
  // Fallback para respuestas con cabeceras/body gigantes (ej. Hiraoka), donde undici de Node
  // lanza UND_ERR_HEADERS_OVERFLOW. Usa node:https sin límite de cabeceras.
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      maxHeaderSize: 1024 * 1024,
      headers: {
        'User-Agent': UA_ACTUAL,
        'Accept-Language': `${monedaLocal.locale || 'es'},es;q=0.9`,
        Accept: tipo === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        if (r.statusCode >= 400) { reject(new Error(`HTTP ${r.statusCode}`)); return; }
        const body = Buffer.concat(chunks).toString('utf8');
        if (tipo === 'json') { try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON inválido en ' + url)); } }
        else resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function pedir(url, tipo = 'text', intentos = 2) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA_ACTUAL,
          'Accept-Language': `${monedaLocal.locale || 'es'},es;q=0.9`,
          Accept: tipo === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (tipo === 'json') return await r.json();
      if (tipo === 'raw') return { status: r.status, texto: await r.text() };
      return await r.text();
    } catch (e) {
      ultimo = e;
      if (e?.cause?.code === 'UND_ERR_HEADERS_OVERFLOW') {
        try { return await pedirGrande(url, tipo); } catch (e2) { ultimo = e2; }
      }
      await dormir(800 * (i + 1));
    }
  }
  throw ultimo;
}

const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[^0-9.,]/g, '');
  if (!s) return null;
  const coma = s.lastIndexOf(',');
  const punto = s.lastIndexOf('.');
  let limpio;
  if (coma > -1 && punto > -1) {
    limpio = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma > -1) {
    const partes = s.split(',');
    limpio = partes.length > 2 || partes[1].length === 3 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (punto > -1) {
    const partes = s.split('.');
    limpio = partes.length > 2 || partes[1].length === 3 ? s.replace(/\./g, '') : s;
  } else {
    limpio = s;
  }
  const n = Number(limpio);
  return isFinite(n) ? n : null;
};

function armar({ tienda, nombre, marca, precio, moneda, precioLista, disponible, url, imagen, categoria }) {
  const p = Math.round(Number(precio) * 100) / 100;
  if (!isFinite(p) || p <= 0) return null;
  const l = precioLista != null && isFinite(Number(precioLista)) && Number(precioLista) > p ? Math.round(Number(precioLista) * 100) / 100 : null;
  return {
    tienda,
    nombre: String(nombre || '').trim().replace(/\s+/g, ' '),
    marca: marca ? String(marca).trim().replace(/\s+/g, ' ') : null,
    precio: p,
    moneda: moneda || COD_LOC,
    precioLista: l,
    disponible: disponible === true ? true : disponible === false ? false : null,
    url: url || null,
    imagen: imagen || null,
    categoria: categoria || null,
  };
}

// ---------- Biblioteca de adaptadores (cada fuente en config.json declara su "tipo") ----------

async function leerVtex(fuente, params) {
  const { base, categorias = [], catId, catIds = [], excluir = [], paginasMax = 12, paso = 49, searchSub = '' } = params || {};
  const patronCat = categorias.length ? new RegExp('\\/(' + categorias.map(escRg).join('|') + ')\\/', 'i') : null;
  const ids = catIds.length ? catIds : catId ? [catId] : [];
  const productos = [];
  let desde = 0;
  for (let pagina = 0; pagina < paginasMax; pagina++) {
    const fq = ids.length ? `&fq=${ids.map((seg, i) => `${i ? '&fq=' : ''}C:/${seg}/`).join('')}` : '';
    const url = `${base}/api/catalog_system/pub/products/search${searchSub}?_from=${desde}&_to=${desde + paso}&O=OrderByPriceDESC${fq}`;
    let arr;
    try {
      arr = await pedir(url, 'json');
    } catch (e) {
      // Cuando ya se capturaron resultados, un 400 (fin del rango de búsqueda de VTEX)
      // cierra la paginación de forma natural, no como error de la fuente.
      if (productos.length === 0) throw e;
      break;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const prod of arr) {
      const cats = prod.categories || [];
      const cat = patronCat ? cats.find((c) => patronCat.test(c)) : cats[0];
      if (!cat) continue;
      if (excluir.some((seg) => cat.toLowerCase().includes(seg.toLowerCase()))) continue;
      const item = (prod.items || [])[0];
      const off = item?.sellers?.[0]?.commertialOffer || {};
      const fila = armar({
        tienda: fuente.id,
        nombre: prod.productName || prod.productTitle,
        marca: prod.brand,
        precio: off.Price,
        moneda: params?.moneda || off.Currency || COD_LOC,
        precioLista: off.ListPrice,
        disponible: typeof off.IsAvailable === 'boolean' ? off.IsAvailable : null,
        url: prod.link,
        imagen: item?.images?.[0]?.imageUrl,
        categoria: cat,
      });
      if (fila) productos.push(fila);
    }
    // VTEX puede devolver páginas parciales antes del final (p. ej. por orden inestable);
    // se avanza por el tamaño real recibido y se corta solo cuando una página viene vacía.
    if (!arr.length) break;
    desde += arr.length;
    await dormir(400);
  }
  return { productos, meta: { fuente: `${base.replace(/\/+$/, '')}/api/catalog_system/pub/products/search` } };
}

async function leerShopify(fuente, params) {
  const { base, coleccion = null, moneda, tipos = [], excluirPrefijos = [] } = params || {};
  const permite = (p) => {
    if (tipos.length && !tipos.includes(p.product_type)) return false;
    const handle = String(p.handle || '');
    if (excluirPrefijos.some((pre) => handle.startsWith(pre))) return false;
    return true;
  };
  const productos = [];
  for (let pagina = 1; pagina <= 6; pagina++) {
    const url = coleccion
      ? `${base}/collections/${coleccion}/products.json?limit=250&page=${pagina}`
      : `${base}/products.json?limit=250&page=${pagina}`;
    const data = await pedir(url, 'json');
    const arr = data?.products || [];
    if (!arr.length) break;
    for (const p of arr) {
      if (!permite(p)) continue;
      const v = (p.variants || [])[0] || {};
      const fila = armar({
        tienda: fuente.id,
        nombre: p.title,
        marca: p.vendor,
        precio: v.price,
        moneda: moneda || COD_EXT,
        precioLista: v.compare_at_price,
        disponible: typeof v.available === 'boolean' ? v.available : null,
        url: `${base}/en/products/${p.handle}`,
        imagen: p.images?.[0]?.src,
        categoria: p.product_type || coleccion,
      });
      if (fila) productos.push(fila);
    }
    if (arr.length < 250) break;
    await dormir(400);
  }
  return { productos, meta: { fuente: coleccion ? `collections/${coleccion}/products.json` : 'products.json' } };
}

async function leerWoocommerce(fuente, params) {
  const { base, categoriaId, categoriaNombre } = params || {};
  const productos = [];
  for (let pagina = 1; pagina <= 6; pagina++) {
    const url = `${base}/wp-json/wc/store/v1/products?category=${categoriaId}&per_page=100&page=${pagina}`;
    const arr = await pedir(url, 'json');
    if (!Array.isArray(arr) || !arr.length) break;
    for (const p of arr) {
      const precio = p.prices?.price != null ? Number(p.prices.price) / 100 : null;
      const lista = p.prices?.regular_price != null ? Number(p.prices.regular_price) / 100 : null;
      const fila = armar({
        tienda: fuente.id,
        nombre: p.name,
        marca: null,
        precio,
        moneda: p.prices?.currency_code || COD_LOC,
        precioLista: p.on_sale ? lista : null,
        disponible: typeof p.is_in_stock === 'boolean' ? p.is_in_stock : null,
        url: p.permalink,
        imagen: p.images?.[0]?.src,
        categoria: categoriaNombre,
      });
      if (fila) productos.push(fila);
    }
    if (arr.length < 100) break;
    await dormir(400);
  }
  return { productos, meta: { categoria: categoriaNombre, fuente: `wp-json/wc/store/v1/products?category=${categoriaId}` } };
}

// PrestaShop sin API pública: se parsea el HTML del listado de la categoría declarada.
// El bloque de regex depende de la plantilla del tema; si el tema cambia, ajustar con muestra real.
async function leerPrestaCategoria(fuente, params) {
  const { base, path = '', categoriaNombre = 'categoría', paginasMax = 8 } = params || {};
  const mapa = new Map();
  const bloque = /<div class="tvproduct-image"><a href="[^"]+" class="thumbnail product-thumbnail"><img[^>]*?(?:data-src|src)="([^"]+)"[^>]*>[\s\S]*?tvproduct-name product-title"><a href="([^"]+)"><h6>([^<]+)<\/h6>[\s\S]*?product-price-and-shipping">([\s\S]*?)<\/div><\/div>/g;
  const extraer = (html) => {
    let nuevos = 0;
    for (const m of html.matchAll(bloque)) {
      const [, imagen, enlace, nombre, bloquePrecio] = m;
      if (mapa.has(enlace)) continue;
      const precio = num((bloquePrecio.match(new RegExp(`class="price">${escRg(monedaLocal.simbolo)}\\s*([\\d.,]+)`)) || [])[1]);
      const lista = num((bloquePrecio.match(new RegExp(`class="regular-price">${escRg(monedaLocal.simbolo)}\\s*([\\d.,]+)`)) || [])[1]);
      const fila = armar({ tienda: fuente.id, nombre, marca: null, precio, moneda: COD_LOC, precioLista: lista, disponible: null, url: enlace, imagen, categoria: categoriaNombre });
      if (fila) { mapa.set(enlace, fila); nuevos++; }
    }
    return nuevos;
  };

  const htmlUna = await pedir(`${base}${path}?resultsPerPage=120`, 'text');
  extraer(htmlUna);

  if (mapa.size <= 13) {
    for (let pagina = 1; pagina <= paginasMax; pagina++) {
      const html = await pedir(`${base}${path}?page=${pagina}`, 'text');
      const encontrados = [...html.matchAll(bloque)].length;
      extraer(html);
      if (encontrados === 0) break;
      await dormir(600);
    }
  }

  const productos = [...mapa.values()];
  if (!productos.length) throw new Error('patrón HTML de listado no reconocido (0 productos)');
  return { productos, meta: { categoria: `Categoría ${categoriaNombre} (${path})`, fuente: `HTML de categoría (PrestaShop, sin API pública) · ${base}${path}` } };
}

// SPA sobre plataforma IDBI: API pública de productos sin auth.
// Los precios se dejan en la moneda que publica la web y el FX del panel la convierte.
async function leerIdbi(fuente, params) {
  const { base, storeSlug, raices = [], excluirPrefijos = [], precioMinimo = 0 } = params || {};
  const RAICES = new Set(raices);
  const url = `https://api.idbi.pe/api/v6/e-commerce/stores/${storeSlug}/products`;
  const data = await pedir(url, 'json');
  const arr = Array.isArray(data?.data) ? data.data : [];
  const productos = [];
  for (const p of arr) {
    const sub = p.category?.name || '';
    const padre = p.category?.parent?.name || '';
    const raiz = padre ? p.category?.parent?.parent?.name || padre : sub;
    if (!RAICES.has(raiz)) continue;
    const slug = String(p.slug || '');
    const nombre = String(p.name || '');
    if (excluirPrefijos.some((pre) => slug.includes(pre) || nombre.includes(pre))) continue;
    const precioUSD = p.prices?.data?.[0]?.price;
    const listaUSD = p.prices?.data?.[0]?.compare_to;
    if (!(isFinite(Number(precioUSD)) && Number(precioUSD) > 0)) continue;
    if (Number(precioUSD) < Number(precioMinimo)) continue;
    const fila = armar({
      tienda: fuente.id,
      nombre: p.name,
      marca: p.vendor || null,
      precio: Number(precioUSD),
      moneda: p.prices?.data?.[0]?.currency || COD_EXT,
      precioLista: listaUSD > precioUSD ? listaUSD : null,
      disponible: p.is_available === true ? true : p.is_available === false ? false : null,
      url: `${base}/products/${p.slug}`,
      imagen: p.media?.[0]?.url || p.media?.[0]?.image || null,
      categoria: raiz,
    });
    if (fila) productos.push(fila);
  }
  if (!productos.length) throw new Error('0 productos en la API de IDBI');
  return { productos, meta: { fuente: `api/v6/e-commerce/stores/${storeSlug}/products (IDBI)` } };
}

// Adaptador genérico por JSON-LD (schema.org Product) embebido en la página pública.
// Lee la página de categoría (o la portada) y extrae productos del marcado estructurado:
// nombre, imagen, URL, oferta (precio, moneda, disponibilidad). No depende de selectores
// por tienda; si la web no expone Product en application/ld+json se reporta "sin catálogo".
async function leerJsonLdCategoria(fuente, params) {
  const { base, path = '', categoriaNombre = 'Categoría', paginasMax = 4 } = params || {};
  const decod = (s) => String(s)
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
  const recoger = (d, arr, visto = new Set()) => {
    if (Array.isArray(d)) { for (const x of d) recoger(x, arr, visto); return arr; }
    if (!d || typeof d !== 'object') return arr;
    if (visto.has(d)) return arr;
    visto.add(d);
    const tipos = Array.isArray(d['@type']) ? d['@type'] : (d['@type'] ? [d['@type']] : []);
    if (tipos.includes('Product')) { arr.push(d); return arr; }
    for (const k of ['@graph', 'mainEntity', 'itemListElement', 'hasPart', 'mentions']) {
      if (d[k] != null) recoger(d[k], arr, visto);
    }
    return arr;
  };
  const docJSON = (html) => {
    const out = [];
    const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      try { out.push(JSON.parse(decod(m[1]))); } catch { /* bloque inválido */ }
    }
    return out;
  };
  const estadoDe = (av) => {
    if (!av) return null;
    const a = String(av).toLowerCase();
    if (a.includes('instock')) return true;
    if (a.includes('outofstock') || a.includes('out of stock') || a.includes('preorder') || a.includes('backorder')) return false;
    return null;
  };
  const ofertaDe = (o) => {
    const of = Array.isArray(o) ? o[0] : o;
    if (!of) return {};
    const raw = of.price != null ? of.price : (of.lowPrice != null ? of.lowPrice : of.highPrice);
    return { precio: num(raw), moneda: of.priceCurrency, disponible: estadoDe(of.availability) };
  };
  const mapa = new Map();
  for (let pagina = 1; pagina <= paginasMax; pagina++) {
    const sep = path.includes('?') ? '&' : '?';
    const url = pagina === 1 ? `${base}${path || ''}` : `${base}${path || ''}${sep}page=${pagina}`;
    let html;
    try {
      html = await pedir(url, 'text');
    } catch (e) {
      if (pagina === 1) throw e;
      break;
    }
    let nuevos = 0;
    for (const d of docJSON(html)) {
      for (const prod of recoger(d, [])) {
        if (!prod.name) continue;
        const o = ofertaDe(prod.offers);
        if (!(isFinite(o.precio) && o.precio > 0)) continue;
        const u = prod.url != null ? String(prod.url) : prod.name;
        if (mapa.has(u)) continue;
        const img = Array.isArray(prod.image) ? prod.image[0] : prod.image;
        const fila = armar({
          tienda: fuente.id,
          nombre: prod.name,
          marca: prod.brand ? (prod.brand.name || prod.brand) : null,
          precio: o.precio,
          moneda: o.moneda || params?.moneda || COD_LOC,
          precioLista: null,
          disponible: o.disponible,
          url: prod.url || null,
          imagen: img || null,
          categoria: categoriaNombre,
        });
        if (fila) { mapa.set(u, fila); nuevos++; }
      }
    }
    if (nuevos < 8 || pagina >= paginasMax) break;
    await dormir(600);
  }
  const productos = [...mapa.values()];
  if (!productos.length) throw new Error(`Sin productos JSON-LD (schema.org Product) en ${base}${path || ''}`);
  return {
    productos,
    meta: { categoria: categoriaNombre === 'Categoría' ? `Categoría ${path || 'portada'}` : categoriaNombre, fuente: `application/ld+json (schema.org) · ${base}${path || ''}` },
  };
}

// Categorías Magento en HTML servidas por el lado servidor (plantilla estándar Magento 2):
// tarjetas "product-item" con <a class="product-item-link">, precio final en [data-price-amount] y
// precio tachado dentro de .old-price. El patrón depende de la plantilla: ajustar con muestra real si cambia.
async function leerMagentoGrid(fuente, params) {
  const { base, paths = [], categoriaNombre = 'categoría', paginasMax = 4, moneda } = params || {};
  const mapa = new Map();
  const agrega = (html) => {
    let nuevos = 0;
    const bloques = html.split(/<li\b[^>]*product-item[^>]*>/gi);
    for (let i = 1; i < bloques.length; i++) {
      const b = bloques[i];
      const enlace = (b.match(/product-item-link[^>]*href="([^"]+)"/) || [])[1];
      const nombre = (b.match(/product-item-link[^>]*>\s*([^<]+)\s*<\/a>/) || [])[1];
      if (!enlace || !nombre) continue;
      if (mapa.has(enlace)) continue;
      const final = (b.match(/data-price-amount="([\d.]+)"/) || [])[1];
      const tachado = b.includes('old-price') ? (b.match(/old-price[\s\S]{0,400}?data-price-amount="([\d.]+)"/) || [])[1] : null;
      const img = (b.match(/(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp))"/i) || [])[1] || null;
      const fila = armar({
        tienda: fuente.id,
        nombre: String(nombre).trim(),
        marca: null,
        precio: final,
        moneda: moneda || COD_LOC,
        precioLista: tachado && isFinite(Number(tachado)) && Number(tachado) > Number(final) ? tachado : null,
        disponible: null,
        url: enlace,
        imagen: img,
        categoria: categoriaNombre,
      });
      if (fila) { mapa.set(enlace, fila); nuevos++; }
    }
    return nuevos;
  };

  for (const path of paths) {
    for (let p = 1; p <= paginasMax; p++) {
      let html;
      try {
        html = await pedir(`${base}${path}${p === 1 ? '' : '?p=' + p}`, 'text');
      } catch (e) {
        if (p === 1) throw e;
        break;
      }
      const nuevos = agrega(html);
      if (nuevos === 0) break;
      await dormir(500);
    }
  }
  const productos = [...mapa.values()];
  if (!productos.length) throw new Error(`Sin tarjetas de producto Magento en ${base}${paths[0] || ''}`);
  return {
    productos,
    meta: { categoria: categoriaNombre, fuente: `Grid HTML (Magento 2) · ${paths.map((p) => `${base}${p}`).join(', ')}` },
  };
}

// SAP Commerce (Hybris): grid del lado servidor con bloques "product-item" y un
// JSON de producto embebido en data-product-info (name, id, price, brand, category).
// El precio final vive en data-product-info; si el bloque trae "was-price"/old price
// se lee el tachado. La paginación usa el parámetro declarado por función (Hybris
// suele usar ?q=:relevance&page=N con N=1 en la segunda página).
async function leerHybrisGrid(fuente, params) {
  const { base, paths = [], categoriaNombre = 'categoría', paginasMax = 3, queryPage = 'page', qBase = ':relevance', device = 'DESKTOP', moneda } = params || {};
  // Marathon (SAP Commerce) exige el parámetro "device" cuando la URL lleva query:
  // sin él, el servidor devuelve una página de redirección (challenge) en vez del grid.
  const conQuery = (path, pagina) => {
    const u = new URL(base + path);
    if (device) u.searchParams.set('device', device);
    if (qBase) u.searchParams.set('q', qBase);
    u.searchParams.set(queryPage, String(pagina));
    return u.toString();
  };
  const mapa = new Map();
  const agrega = (html) => {
    let nuevos = 0;
    const bloques = html.split(/<div class="product-item">/gi);
    for (let i = 1; i < bloques.length; i++) {
      const b = bloques[i];
      const info = (b.match(/data-product-info='([\s\S]*?)'>/) || [])[1];
      if (!info) continue;
      let j;
      try { j = JSON.parse(info); } catch { continue; }
      const enlace = (b.match(/href="([^"]+)"[^>]*>\s*(?:<img|$)/) || [])[1] || (b.match(/class="thumb[^"]*"\s*(?:id="[^"]*"\s*)?href="([^"]+)"/) || [])[1];
      if (!enlace || mapa.has(enlace)) continue;
      const nombre = j.name || (b.match(/title="([^"]+)"/) || [])[1];
      const precio = j.price != null ? Number(j.price) : null;
      if (!nombre || !(isFinite(precio) && precio > 0)) continue;
      const tachado = (b.match(/was-price[^>]*>\s*([\d.,]+)/) || [])[1];
      const img = (b.match(/(?:data-src|src)="(\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i) || [])[1] || null;
      const fila = armar({
        tienda: fuente.id,
        nombre: String(nombre).trim(),
        marca: j.brand || null,
        precio,
        moneda: moneda || COD_LOC,
        precioLista: tachado && isFinite(Number(tachado)) && Number(tachado) > precio ? tachado : null,
        disponible: null,
        url: base + enlace,
        imagen: img ? 'https:' + img : null,
        categoria: j.category || categoriaNombre,
      });
      if (fila) { mapa.set(enlace, fila); nuevos++; }
    }
    return nuevos;
  };

  for (const path of paths) {
    for (let p = 0; p < paginasMax; p++) {
      const url = conQuery(path, p);
      let html;
      try {
        html = await pedir(url, 'text');
      } catch (e) {
        if (p === 0) throw e;
        break;
      }
      const nuevos = agrega(html);
      if (nuevos === 0) break;
      await dormir(500);
    }
    await dormir(300);
  }
  const productos = [...mapa.values()];
  if (!productos.length) throw new Error(`Sin bloques product-item de Hybris en ${base}${paths[0] || ''}`);
  return {
    productos,
    meta: { categoria: categoriaNombre, fuente: `Grid HTML (SAP Commerce / Hybris) · ${paths.map((pa) => `${base}${pa}`).join(', ')}` },
  };
}

// Sitio sin catálogo ni API: se reporta presencia/ausencia de precios en el HTML público.
async function leerEstatico(fuente, params) {
  const { base } = params || {};
  const html = await pedir(base, 'text');
  const patron = new RegExp(escRg(monedaLocal.simbolo) + '\\s?[\\d.,]+', 'g');
  const precios = html.match(patron) || [];
  return {
    productos: [],
    meta: {
      categoria: `Sitio institucional (${fuente.plataforma}) sin catálogo de precios`,
      fuente: 'HTML de la portada',
      nota: precios.length
        ? `Se detectaron ${precios.length} coincidencias de precio (${monedaLocal.simbolo}) en la portada; revisar manualmente.`
        : `Sin precios publicados en el HTML público de la portada (0 coincidencias de "${monedaLocal.simbolo}").`,
    },
  };
}

const ADAPTADORES = {
  vtex: leerVtex,
  shopify: leerShopify,
  woocommerce: leerWoocommerce,
  'prestashop-categoria': leerPrestaCategoria,
  'jsonld-categoria': leerJsonLdCategoria,
  'magento-grid': leerMagentoGrid,
  'hybris-grid': leerHybrisGrid,
  idbi: leerIdbi,
  estatico: leerEstatico,
};

const FUENTES = CFG.fuentes.map((f) => {
  const correr = ADAPTADORES[f.tipo];
  if (!correr) throw new Error(`Tipo de adaptador no reconocido en config.json: "${f.tipo}" (fuente ${f.id}).`);
  return { ...f, correr };
});
const uaFuente = (id) => uaDe(FUENTES.find((f) => f.id === id));

// ---------- Tipo de cambio (para las fuentes que publican en la moneda de referencia) ----------
async function tipoCambio(previo) {
  try {
    const d = await pedir(`${CFG.apiFx}${COD_EXT}`, 'json');
    const tasa = d?.rates?.[COD_LOC];
    if (!isFinite(tasa)) throw new Error(`${COD_LOC} no disponible en ${CFG.apiFx}`);
    return { ok: true, tasa, monedaBase: COD_EXT, monedaLocal: COD_LOC, fuente: `${CFG.apiFx.replace(/\/+$/, '')} (tipo de cambio de referencia)`, obtenidoEn: new Date().toISOString() };
  } catch (e) {
    if (previo?.tasa) return { ...previo, ok: false, advertencia: `No se pudo actualizar el tipo de cambio: ${e.message}` };
    return { ok: false, tasa: null, monedaBase: COD_EXT, monedaLocal: COD_LOC, fuente: null, advertencia: `Sin tipo de cambio: ${e.message}` };
  }
}

// ---------- Revalidación diaria de políticas de envío (base declarada en config.envios) ----------
async function validarEnvios(previo) {
  const prevHash = Object.fromEntries((previo?.envios || []).map((e) => [e.tienda, e.hash]));
  const salida = [];
  for (const e of CFG.envios) {
    UA_ACTUAL = uaFuente(e.tienda);
    const fila = { ...e, verificadoEn: new Date().toISOString(), estado: 'ok', hash: null, cambioDetectado: false };
    try {
      const { texto } = await pedir(e.fuente, 'raw');
      const limpio = texto.replace(/\s+/g, ' ').trim();
      fila.hash = String(limpio.length);
      const fragmento = limpio.match(/.{0,160}(env[ií]o|delivery|despacho|flete|costo).{0,220}/i)?.[0] || '';
      fila.evidencia = fragmento.slice(0, 340);
      if (prevHash[e.tienda] && prevHash[e.tienda] !== fila.hash) fila.cambioDetectado = true;
    } catch (err) {
      fila.estado = 'error';
      fila.error = err.message;
      fila.evidencia = null;
    }
    salida.push(fila);
    await dormir(500);
  }
  return salida;
}

// ---------- Main ----------
const previo = existsSync(DATA) ? JSON.parse(await readFile(DATA, 'utf8')) : null;
const inicio = Date.now();
const fuentes = [];
const productos = [];

for (const f of FUENTES) {
  UA_ACTUAL = uaDe(f);
  const registro = {
    id: f.id, nombre: f.nombre, rol: f.rol, url: f.url, plataforma: f.plataforma, segmento: f.segmento || null,
    estado: 'ok', error: null, productos: 0, categoria: null, fuenteDato: null, nota: null,
    leidoEn: new Date().toISOString(), datosDe: null,
  };
  try {
    const { productos: ps, meta } = await f.correr(f, f.params || {});
    registro.productos = ps.length;
    registro.categoria = meta.categoria || f.segmento || null;
    registro.fuenteDato = meta.fuente || null;
    registro.nota = meta.nota || null;
    productos.push(...ps);
  } catch (e) {
    const previos = (previo?.productos || []).filter((p) => p.tienda === f.id);
    registro.estado = previos.length ? 'error' : 'vacio';
    registro.error = e.message;
    registro.productos = previos.length;
    registro.datosDe = previo?.generadoEn || null;
    productos.push(...previos);
  }
  fuentes.push(registro);
  await dormir(500);
}

const fx = await tipoCambio(previo?.fx);
for (const p of productos) {
  if (p.moneda === COD_EXT) {
    if (fx.tasa) {
      p.precioOriginal = p.precio;
      p.precio = Math.round(p.precio * fx.tasa * 100) / 100;
      p.moneda = COD_LOC;
      p.convertido = true;
    } else {
      p.noComparable = true;
    }
  }
}

// Segmento declarado (config.segmentos): clasifica cada producto por coincidencia
// de patrones sobre su campo "categoria". Es una regla de etiquetado, no una
// categoría oficial de las tiendas.
const SEGMENTOS = CFG.segmentos || [];
for (const p of productos) {
  const txt = String(p.categoria || p.nombre || '');
  const n = txt.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const m = SEGMENTOS.find((s) => (s.patrones || []).some((pat) => n.includes(pat)));
  p.segmento = m ? m.id : 'sin-segmento';
}

const envios = await validarEnvios(previo);

const conPrecio = productos.filter((p) => isFinite(p.precio) && p.precio > 0);
const salida = {
  generadoEn: new Date().toISOString(),
  duracionMs: Date.now() - inicio,
  config: CFG,
  resumen: {
    productos: conPrecio.length,
    fuentesOk: fuentes.filter((f) => f.estado === 'ok').length,
    fuentesTotal: fuentes.length,
    convertidos: productos.filter((p) => p.convertido).length,
    sinPrecio: productos.filter((p) => p.noComparable).length,
    conDescuento: productos.filter((p) => p.precioLista).length,
  },
  fx,
  fuentes,
  envios,
  productos,
};

await writeFile(DATA, JSON.stringify(salida), 'utf8');
console.log(`OK: ${salida.resumen.productos} productos · ${salida.resumen.fuentesOk}/${salida.resumen.fuentesTotal} fuentes · ${salida.duracionMs} ms`);
for (const f of fuentes) console.log(`  - ${f.nombre}: ${f.estado} · ${f.productos} productos${f.error ? ' · ' + f.error : ''}`);
if (salida.resumen.fuentesOk === 0) process.exit(1);