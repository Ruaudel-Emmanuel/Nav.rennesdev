// Nav.rennesdev — navigateur web léger côté VPS (v1)
// Le VPS charge la page, la nettoie et la sert en mode lecture.
// Zéro dépendance npm (Node 22, modules intégrés uniquement).
'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const zlib = require('zlib');
const { URL } = require('url');

const PORT = 8086;
const MAX_BYTES = 3 * 1024 * 1024; // 3 Mo
const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 NavRennesdev/1.0';

/* ---------- Garde-fous SSRF ---------- */
function estIpPrivee(ip) {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return estIpPrivee(v.slice(7));
    if (/^f[cd]/.test(v)) return true;          // fc00::/7 unique local
    if (/^fe[89ab]/.test(v)) return true;       // fe80::/10 link local
    return false;
  }
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => isNaN(n))) return true;
  if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true;
  if (o[0] === 169 && o[1] === 254) return true;             // link local
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // privé
  if (o[0] === 192 && o[1] === 168) return true;             // privé
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT (Tailscale)
  if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true;
  if (o[0] >= 224) return true;                              // multicast/réservé
  return false;
}

async function verifSsrf(nom) {
  const res = await dns.lookup(nom, { all: true, verbatim: true });
  if (!res.length) throw new Error('Nom de domaine introuvable');
  for (const r of res) {
    if (estIpPrivee(r.address)) {
      throw new Error('Adresse non autorisée (réseau privé)');
    }
  }
}

/* ---------- Téléchargement ---------- */
function telecharge(pageUrl, redirects) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(pageUrl); } catch { return reject(new Error('URL invalide')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new Error('Seuls http et https sont autorisés'));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('Trop de redirections'));
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirection sans destination'));
        const next = new URL(loc, u).href;
        return resolve(telecharge(next, redirects + 1));
      }
      if (res.statusCode === 429) return reject(new Error('Trop de requêtes sur le site source (429) — réessaie plus tard'));
      if (res.statusCode >= 400) return reject(new Error('La page a répondu HTTP ' + res.statusCode));

      const ctype = String(res.headers['content-type'] || '');
      if (!/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
        res.resume();
        return reject(new Error('Contenu non HTML (' + (ctype.split(';')[0] || 'type inconnu') + ') — ouvre l\u2019original'));
      }
      const enc = /gzip/.test(String(res.headers['content-encoding'] || '')) ? 'gzip'
        : /deflate/.test(String(res.headers['content-encoding'] || '')) ? 'deflate' : null;

      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_BYTES) {
          req.destroy();
          return reject(new Error('Page trop volumineuse (> 3 Mo)'));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
        } catch (e) { /* contenu brut si décompression impossible */ }
        resolve({ buf, ctype });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('Délai dépassé (20 s)')); });
    req.on('error', reject);
  });
}

async function litPage(pageUrl) {
  const u = new URL(pageUrl);
  await verifSsrf(u.hostname);
  return telecharge(pageUrl, 0);
}

/* ---------- Décodage du corps ---------- */
function decode(buf, ctype) {
  let charset = /charset=([\w-]+)/i.exec(ctype || '');
  charset = charset ? charset[1].toLowerCase() : null;
  if (!charset) {
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.toString('latin1').slice(0, 4096));
    charset = meta ? meta[1].toLowerCase() : 'utf-8';
  }
  try {
    return new TextDecoder(charset === 'utf8' ? 'utf-8' : charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/* ---------- Entités HTML dans les valeurs d'attributs ---------- */
function decodeEntites(s) {
  const A = '\u0026';
  const nomme = {};
  nomme[A + 'amp;'] = A;
  nomme[A + 'lt;'] = String.fromCharCode(60);
  nomme[A + 'gt;'] = String.fromCharCode(62);
  nomme[A + 'quot;'] = String.fromCharCode(34);
  nomme[A + '#39;'] = String.fromCharCode(39);
  nomme[A + 'apos;'] = String.fromCharCode(39);
  nomme[A + 'nbsp;'] = ' ';
  s = s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => nomme[m] ?? m);
  s = s.replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ' '; } });
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } });
  return s;
}

/* ---------- Résolution d'URL ---------- */
function absolu(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch { return null; }
}

/* ---------- Nettoyage / réécriture HTML ---------- */
const TAGS_SUPPRIMES = [
  /<script[\s\S]*?<\/script>/gi, /<script[^>]*\/?>/gi,
  /<style[\s\S]*?<\/style>/gi, /<style[^>]*\/?>/gi,
  /<noscript[\s\S]*?<\/noscript>/gi,
  /<iframe[\s\S]*?<\/iframe>/gi, /<iframe[^>]*\/?>/gi,
  /<svg[\s\S]*?<\/svg>/gi,
  /<form[\s\S]*?<\/form>/gi, /<form[^>]*\/?>/gi,
  /<input[^>]*>/gi, /<button[\s\S]*?<\/button>/gi, /<button[^>]*\/?>/gi,
  /<select[\s\S]*?<\/select>/gi, /<textarea[\s\S]*?<\/textarea>/gi,
  /<video[\s\S]*?<\/video>/gi, /<audio[\s\S]*?<\/audio>/gi,
  /<canvas[\s\S]*?<\/canvas>/gi,
  /<template[\s\S]*?<\/template>/gi,
  /<!--[\s\S]*?-->/g,
];

function nettoie(html, baseUrl) {
  let t = html;
  for (const re of TAGS_SUPPRIMES) t = t.replace(re, ' ');
  // attributs dangereux ou inutiles
  t = t
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' ')
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, ' ')
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*')/gi, ' ')
    .replace(/\sclass\s*=\s*("[^"]*"|'[^']*')/gi, ' ')
    .replace(/\sid\s*=\s*("[^"]*"|'[^']*')/gi, ' ')
    .replace(/\sdata-[\w-]+\s*=\s*("[^"]*"|'[^']*')/gi, ' ');
  // liens → routés par le VPS (href déjà encodé par URL.href ; on protège seulement le & du paramètre)
  t = t.replace(/(<a\b[^>]*\shref\s*=\s*)("([^"]*)"|'([^']*)')/gi, (m, pre, q, d, s) => {
    const href = absolu(decodeEntites(d ?? s), baseUrl);
    if (!href) return pre + '"#"';
    return pre + '"/go?url=' + href.replace(/&/g, '%26') + '"';
  });
  // images : URL absolues, chargées directement par le navigateur du client
  t = t.replace(/(<img\b[^>]*\ssrc\s*=\s*)("([^"]*)"|'([^']*)')/gi, (m, pre, q, d, s) => {
    const src = absolu(decodeEntites(d ?? s), baseUrl);
    if (!src) return pre + '""';
    return pre + '"' + src.replace(/"/g, '"') + '"';
  });
  return t;
}

function extrait(html, baseUrl) {
  const titre = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
  let corps = null;
  const article = /<article\b[^>]*>([\s\S]{500,}?)<\/article>/i.exec(html);
  const main = /<main\b[^>]*>([\s\S]{500,}?)<\/main>/i.exec(html);
  if (article) corps = article[0];
  else if (main) corps = main[0];
  else {
    const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
    corps = body ? body[1] : html;
  }
  const contenu = nettoie(corps, baseUrl);
  const titrePropre = titre ? titre.replace(/\s+/g, ' ').trim().slice(0, 200) : baseUrl;
  return { titre: titrePropre, contenu };
}

/* ---------- Gabarits ---------- */
const CSS = `
  :root { --txt:#1a1a1a; --bg:#ffffff; --muted:#666; --bar:#f5f5f5; --link:#0a58ca; --bord:#ddd; }
  @media (prefers-color-scheme: dark) {
    :root { --txt:#e8e8e8; --bg:#141414; --muted:#999; --bar:#1e1e1e; --link:#6cb2ff; --bord:#333; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:16px/1.65 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }
  .barre { position:sticky; top:0; z-index:10; background:var(--bar); border-bottom:1px solid var(--bord); padding:8px 12px; display:flex; gap:8px; }
  .barre form { flex:1; display:flex; gap:8px; }
  .barre input[type=url] { flex:1; padding:8px 12px; border:1px solid var(--bord); border-radius:8px; background:var(--bg); color:var(--txt); font-size:15px; }
  .barre button { padding:8px 14px; border:1px solid var(--bord); border-radius:8px; background:var(--bg); color:var(--txt); cursor:pointer; white-space:nowrap; }
  .barre button:hover { border-color:var(--link); }
  .page { max-width:760px; margin:0 auto; padding:20px 16px 60px; }
  .titre { font-size:1.35em; margin:12px 0 4px; }
  .source { color:var(--muted); font-size:.85em; margin-bottom:24px; word-break:break-all; }
  .contenu img { max-width:100%; height:auto; border-radius:6px; }
  .contenu a { color:var(--link); }
  .contenu pre { overflow:auto; background:var(--bar); padding:12px; border-radius:8px; }
  .contenu table { border-collapse:collapse; } .contenu td,.contenu th { border:1px solid var(--bord); padding:4px 8px; }
  .contenu h1,.contenu h2,.contenu h3 { line-height:1.3; }
  .accueil { max-width:640px; margin:12vh auto 0; padding:0 16px; text-align:center; }
  .accueil h1 { font-weight:600; letter-spacing:.5px; }
  .accueil .sous { color:var(--muted); margin-bottom:28px; }
  .accueil form { display:flex; gap:8px; }
  .accueil input { flex:1; padding:12px 16px; border:1px solid var(--bord); border-radius:10px; background:var(--bg); color:var(--txt); font-size:16px; }
  .accueil button { padding:12px 20px; border:1px solid var(--bord); border-radius:10px; background:var(--bar); color:var(--txt); cursor:pointer; }
  .histo { text-align:left; margin-top:36px; }
  .histo a { display:block; padding:8px 10px; color:var(--txt); text-decoration:none; border-radius:8px; }
  .histo a:hover { background:var(--bar); }
  .histo .u { color:var(--muted); font-size:.8em; word-break:break-all; }
  .erreur { max-width:640px; margin:14vh auto 0; padding:0 16px; text-align:center; }
  .erreur .code { font-size:2.6em; margin-bottom:8px; }
`;

function escHtml(s) {
  return String(s)
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;')
    .replace(/"/g, '\u0026quot;');
}

function escText(s) {
  return String(s)
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;');
}

function pageAccueil() {
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<meta name="robots" content="noindex">\n' +
    '<title>Nav.rennesdev</title><style>' + CSS + '</style></head><body>\n' +
    '<div class="accueil">\n' +
    '  <h1>Nav.rennesdev</h1>\n' +
    '  <div class="sous">Navigateur léger — les pages sont chargées et nettoyées par le VPS (mode lecture)</div>\n' +
    '  <form action="/go" method="get">\n' +
    '    <input type="url" name="url" placeholder="Adresse de la page (https://…)" required autofocus>\n' +
    '    <button type="submit">Aller</button>\n' +
    '  </form>\n' +
    '  <div class="histo" id="histo"></div>\n' +
    '</div>\n' +
    '<script>\n' +
    '(function(){\n' +
    "  try {\n" +
    "    const h = JSON.parse(localStorage.getItem('nav-historique') || '[]');\n" +
    "    const el = document.getElementById('histo');\n" +
    '    if (h.length) {\n' +
    "      const tit = document.createElement('h3');\n" +
    "      tit.style.fontWeight = '500';\n" +
    "      tit.textContent = 'Derni\\u00e8res pages';\n" +
    "      el.appendChild(tit);\n" +
    "      for (const it of h.slice(0, 12)) {\n" +
    "        const a = document.createElement('a');\n" +
    "        a.href = '/go?url=' + encodeURIComponent(it.u);\n" +
    "        const d1 = document.createElement('div');\n" +
    "        d1.textContent = it.t || it.u;\n" +
    "        const d2 = document.createElement('div');\n" +
    "        d2.className = 'u';\n" +
    "        d2.textContent = it.u;\n" +
    "        a.appendChild(d1); a.appendChild(d2);\n" +
    "        el.appendChild(a);\n" +
    "      }\n" +
    '    }\n' +
    '  } catch(e){}\n' +
    '})();\n' +
    '</script></body></html>';
}

function pageLecture(titre, urlOriginal, contenu) {
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<meta name="robots" content="noindex">\n' +
    '<title>' + escHtml(titre) + ' — Nav.rennesdev</title><style>' + CSS + '</style></head><body>\n' +
    '<div class="barre">\n' +
    "  <button onclick=\"location.href='/'\" title=\"Accueil\">⌂</button>\n" +
    '  <button onclick="history.back()" title="Retour">←</button>\n' +
    '  <form action="/go" method="get"><input type="url" name="url" value="' + escHtml(urlOriginal) + '" placeholder="Nouvelle adresse…"><button type="submit">Aller</button></form>\n' +
    '  <a href="' + escHtml(urlOriginal) + '" target="_blank" rel="noopener" title="Ouvrir l\'original"><button>Original</button></a>\n' +
    '</div>\n' +
    '<div class="page">\n' +
    '  <div class="titre">' + escHtml(titre) + '</div>\n' +
    '  <div class="source">' + escHtml(urlOriginal) + '</div>\n' +
    '  <div class="contenu">' + contenu + '</div>\n' +
    '</div>\n' +
    '<script>\n' +
    '(function(){\n' +
    '  try {\n' +
    "    const h = JSON.parse(localStorage.getItem('nav-historique') || '[]');\n" +
    '    const liste = h.filter((x) => x.u !== ' + JSON.stringify(urlOriginal) + ');\n' +
    '    liste.unshift({ u: ' + JSON.stringify(urlOriginal) + ', t: ' + JSON.stringify(titre) + ' });\n' +
    "    localStorage.setItem('nav-historique', JSON.stringify(liste.slice(0, 50)));\n" +
    '  } catch(e){}\n' +
    '})();\n' +
    '</script></body></html>';
}

function pageErreur(message, urlDemandee) {
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Erreur — Nav.rennesdev</title>\n' +
    '<style>' + CSS + '</style></head><body><div class="erreur">\n' +
    '<div class="code">🚫</div>\n' +
    '<h2>Impossible de charger la page</h2>\n' +
    '<p>' + escHtml(message) + '</p>\n' +
    (urlDemandee ? '<p class="source">' + escHtml(urlDemandee) + '</p><p><a href="/"><button>← Retour à l\'accueil</button></a></p>' : '') +
    '</div></body></html>';
}

/* ---------- Serveur ---------- */
function repond(res, code, type, corps) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(corps);
}

const serveur = http.createServer(async (req, res) => {
  const me = new URL(req.url, 'http://local');

  if (me.pathname === '/health') return repond(res, 200, 'text/plain; charset=utf-8', 'OK');

  if (me.pathname === '/' || me.pathname === '/index.html') {
    return repond(res, 200, 'text/html; charset=utf-8', pageAccueil());
  }

  if (me.pathname === '/go') {
    const cible = (me.searchParams.get('url') || '').trim();
    if (!cible) return repond(res, 302, 'text/plain', '');
    try {
      const { buf, ctype } = await litPage(cible);
      const html = decode(buf, ctype);
      if (!/<\s*(html|body|article|main|div|p|h1)/i.test(html)) {
        return repond(res, 200, 'text/html; charset=utf-8', pageErreur('Le contenu reçu ne ressemble pas à une page web.', cible));
      }
      const { titre, contenu } = extrait(html, cible);
      return repond(res, 200, 'text/html; charset=utf-8', pageLecture(titre, cible, contenu));
    } catch (e) {
      const msg = e && e.message ? e.message : 'Erreur inconnue';
      return repond(res, 200, 'text/html; charset=utf-8', pageErreur(msg, cible));
    }
  }

  return repond(res, 404, 'text/html; charset=utf-8', pageErreur('Page introuvable sur Nav.rennesdev.', null));
});

serveur.listen(PORT, () => console.log(`Nav.rennesdev v1 — écoute sur :${PORT}`));
