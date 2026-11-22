// Christmas Wishlist API — Cloudflare Pages Function (handles every /api/* route).
//
// Required bindings / settings (see README):
//   DB              D1 database binding
//   FAMILY_PASSWORD secret: lets family view lists and mark items as bought
//   OWNER_PASSWORD  secret: lets the list owners add / edit / delete items
//   SITE_TITLE      optional plain variable, e.g. "The Smith Family Wishlist"

const SESSION_DAYS = 120;
const COOKIE = "wl_session";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function onRequest(context) {
  try {
    return await route(context);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

async function route({ request, env }) {
  {
    if (!env.DB) return json({ error: "Database not configured: add a D1 binding named DB." }, 500);
    if (!env.FAMILY_PASSWORD || !env.OWNER_PASSWORD) {
      return json({ error: "Passwords not configured: set FAMILY_PASSWORD and OWNER_PASSWORD." }, 500);
    }
    await ensureSchema(env.DB);

    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const method = request.method.toUpperCase();
    const role = await getRole(request, env);

    // --- Public routes -----------------------------------------------------
    if (parts[0] === "me" && method === "GET") {
      return json({ role, title: env.SITE_TITLE || "Our Christmas Wishlist" });
    }
    if (parts[0] === "login" && method === "POST") return login(request, env);
    if (parts[0] === "logout" && method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }

    // Everything below requires a session.
    if (!role) return json({ error: "Please log in." }, 401);

    if (parts[0] === "data" && method === "GET") return getData(env, role);

    if (parts[0] === "preview" && method === "GET") {
      requireOwner(role);
      return json(await linkPreview(url.searchParams.get("url")));
    }

    if (parts[0] === "people") {
      requireOwner(role);
      const id = parts[1];
      if (!id && method === "POST") return createPerson(request, env);
      if (id && method === "PATCH") return updatePerson(request, env, id);
      if (id && method === "DELETE") return deletePerson(env, id);
    }

    if (parts[0] === "items") {
      const id = parts[1];
      if (id && parts[2] === "claim") {
        if (method === "POST") return claimItem(request, env, role, id);
        if (method === "DELETE") return unclaimItem(env, role, id);
      }
      requireOwner(role);
      if (!id && method === "POST") return createItem(request, env);
      if (id && method === "PATCH") return updateItem(request, env, id);
      if (id && method === "DELETE") return deleteItem(env, id);
    }

    return json({ error: "Not found" }, 404);
  }
}

// ---------------------------------------------------------------------------
// Schema (created automatically on first request, so no manual SQL step)
// ---------------------------------------------------------------------------
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      hide_claims INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      image_url TEXT,
      notes TEXT,
      price TEXT,
      most_wanted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      claimed INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      claimed_at INTEGER
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS items_person ON items(person_id)`),
  ]);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Auth: signed cookie holding the role ("family" or "owner") and an expiry.
// The signing key is derived from both passwords, so changing either password
// logs everybody out.
// ---------------------------------------------------------------------------
async function login(request, env) {
  const body = await readJson(request);
  const password = String(body.password || "");
  let role = null;
  if (await safeEqual(password, env.OWNER_PASSWORD, env)) role = "owner";
  else if (await safeEqual(password, env.FAMILY_PASSWORD, env)) role = "family";
  if (!role) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return json({ error: "That password didn't work." }, 401);
  }
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${role}.${exp}`;
  const token = `${payload}.${await sign(payload, env)}`;
  return json({ ok: true, role }, 200, {
    "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  });
}

async function getRole(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [role, exp, sig] = match[1].split(".");
  if (!role || !exp || !sig) return null;
  if (role !== "owner" && role !== "family") return null;
  if (Number(exp) < Date.now()) return null;
  const expected = await sign(`${role}.${exp}`, env);
  return (await safeEqual(sig, expected, env)) ? role : null;
}

async function hmacKey(env) {
  const secret = `${env.SESSION_SECRET || ""}|${env.OWNER_PASSWORD}|${env.FAMILY_PASSWORD}`;
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(text, env) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Constant-time comparison by comparing HMACs of both values.
async function safeEqual(a, b, env) {
  const [x, y] = await Promise.all([sign(`cmp:${a}`, env), sign(`cmp:${b}`, env)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0 && x.length === y.length;
}

function requireOwner(role) {
  if (role !== "owner") throw new HttpError(403, "Only the list owners can do that.");
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function getData(env, role) {
  const [people, items] = await Promise.all([
    env.DB.prepare(`SELECT * FROM people ORDER BY sort, created_at`).all(),
    env.DB.prepare(`SELECT * FROM items ORDER BY most_wanted DESC, created_at`).all(),
  ]);
  const hidden = new Set(
    people.results.filter((p) => role === "owner" && p.hide_claims).map((p) => p.id)
  );
  return json({
    role,
    people: people.results.map((p) => ({ ...p, hide_claims: !!p.hide_claims })),
    items: items.results.map((it) => {
      const out = { ...it, most_wanted: !!it.most_wanted, claimed: !!it.claimed };
      // Keep the surprise: owners never receive claim info for secret lists.
      if (hidden.has(it.person_id)) {
        out.claimed = null;
        out.claimed_by = null;
        out.claimed_at = null;
      }
      return out;
    }),
  });
}

async function createPerson(request, env) {
  const body = await readJson(request);
  const name = cleanText(body.name, 60);
  if (!name) throw new HttpError(400, "Please enter a name.");
  const max = await env.DB.prepare(`SELECT COALESCE(MAX(sort), 0) AS m FROM people`).first();
  const id = crypto.randomUUID();
  const hide = body.hide_claims === false ? 0 : 1;
  await env.DB.prepare(`INSERT INTO people (id, name, sort, hide_claims, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, name, (max?.m || 0) + 1, hide, Date.now()).run();
  return json({ ok: true, id });
}

async function updatePerson(request, env, id) {
  const body = await readJson(request);
  const person = await env.DB.prepare(`SELECT * FROM people WHERE id = ?`).bind(id).first();
  if (!person) throw new HttpError(404, "That list no longer exists.");
  const name = body.name !== undefined ? cleanText(body.name, 60) : person.name;
  if (!name) throw new HttpError(400, "Please enter a name.");
  const hide = body.hide_claims !== undefined ? (body.hide_claims ? 1 : 0) : person.hide_claims;
  const sort = Number.isFinite(body.sort) ? body.sort : person.sort;
  await env.DB.prepare(`UPDATE people SET name = ?, hide_claims = ?, sort = ? WHERE id = ?`)
    .bind(name, hide, sort, id).run();
  return json({ ok: true });
}

async function deletePerson(env, id) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM items WHERE person_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM people WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

function itemFields(body) {
  const url = cleanUrl(body.url);
  const title = cleanText(body.title, 200) || (url ? new URL(url).hostname.replace(/^www\./, "") : "");
  if (!title) throw new HttpError(400, "Please add a link or a name for the item.");
  return {
    title,
    url,
    image_url: cleanUrl(body.image_url),
    notes: cleanText(body.notes, 2000, true),
    price: cleanText(body.price, 40),
    most_wanted: body.most_wanted ? 1 : 0,
  };
}

async function createItem(request, env) {
  const body = await readJson(request);
  const person = await env.DB.prepare(`SELECT id FROM people WHERE id = ?`).bind(String(body.person_id || "")).first();
  if (!person) throw new HttpError(400, "Pick whose list this goes on.");
  const f = itemFields(body);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO items (id, person_id, title, url, image_url, notes, price, most_wanted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, person.id, f.title, f.url, f.image_url, f.notes, f.price, f.most_wanted, Date.now()).run();
  return json({ ok: true, id });
}

async function updateItem(request, env, id) {
  const body = await readJson(request);
  const item = await env.DB.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first();
  if (!item) throw new HttpError(404, "That item no longer exists.");
  const f = itemFields({ ...item, ...body });
  let personId = item.person_id;
  if (body.person_id && body.person_id !== item.person_id) {
    const p = await env.DB.prepare(`SELECT id FROM people WHERE id = ?`).bind(String(body.person_id)).first();
    if (!p) throw new HttpError(400, "That list no longer exists.");
    personId = p.id;
  }
  await env.DB.prepare(
    `UPDATE items SET person_id = ?, title = ?, url = ?, image_url = ?, notes = ?, price = ?, most_wanted = ? WHERE id = ?`
  ).bind(personId, f.title, f.url, f.image_url, f.notes, f.price, f.most_wanted, id).run();
  return json({ ok: true });
}

async function deleteItem(env, id) {
  await env.DB.prepare(`DELETE FROM items WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

async function canSeeClaims(env, role, itemId) {
  const row = await env.DB.prepare(
    `SELECT i.id, p.hide_claims FROM items i JOIN people p ON p.id = i.person_id WHERE i.id = ?`
  ).bind(itemId).first();
  if (!row) throw new HttpError(404, "That item no longer exists.");
  if (role === "owner" && row.hide_claims) {
    throw new HttpError(403, "This list is secret from owners. Log in with the family password to mark gifts.");
  }
}

async function claimItem(request, env, role, id) {
  await canSeeClaims(env, role, id);
  const body = await readJson(request);
  const name = cleanText(body.name, 60) || null;
  // Only succeeds if nobody claimed it first.
  const res = await env.DB.prepare(
    `UPDATE items SET claimed = 1, claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed = 0`
  ).bind(name, Date.now(), id).run();
  if (!res.meta.changes) throw new HttpError(409, "Someone already marked this one as bought.");
  return json({ ok: true });
}

async function unclaimItem(env, role, id) {
  await canSeeClaims(env, role, id);
  await env.DB.prepare(`UPDATE items SET claimed = 0, claimed_by = NULL, claimed_at = NULL WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Link preview: fetch the product page and pull out a title, image and price.
// ---------------------------------------------------------------------------
async function linkPreview(rawUrl) {
  const target = cleanUrl(rawUrl);
  if (!target) throw new HttpError(400, "That doesn't look like a web link.");

  const found = { title: null, image: null, price: null, ogTitle: null };
  const images = [];
  const ldJson = [];
  let ldBuf = "";
  let titleBuf = "";
  let finalUrl = target;

  try {
    const res = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(9000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    finalUrl = res.url || target;
    const type = res.headers.get("content-type") || "";
    if (type.startsWith("image/")) return { title: null, image: finalUrl, price: null };
    if (!type.includes("html")) return { title: null, image: null, price: null };

    const meta = (attr) => ({
      element(el) {
        const key = (el.getAttribute(attr) || "").toLowerCase();
        const content = el.getAttribute("content");
        if (!content) return;
        if (["og:image", "og:image:secure_url", "og:image:url", "twitter:image", "twitter:image:src"].includes(key)) {
          images.push(content);
        } else if (key === "og:title" || key === "twitter:title") {
          found.ogTitle = found.ogTitle || content;
        } else if (["og:price:amount", "product:price:amount", "twitter:data1"].includes(key) && !found.price) {
          found.price = content;
        } else if ((key === "og:price:currency" || key === "product:price:currency") && !found.currency) {
          found.currency = content;
        }
      },
    });

    await new HTMLRewriter()
      .on("meta[property]", meta("property"))
      .on("meta[name]", meta("name"))
      .on("meta[itemprop='image']", { element(el) { const c = el.getAttribute("content"); if (c) images.push(c); } })
      .on("link[rel='image_src']", { element(el) { const h = el.getAttribute("href"); if (h) images.push(h); } })
      // Amazon product image
      .on("img#landingImage, img#imgBlkFront", {
        element(el) {
          const src = el.getAttribute("data-old-hires") || el.getAttribute("src");
          if (src && !src.startsWith("data:")) images.unshift(src);
        },
      })
      .on("span#productTitle", { text(t) { titleBuf += t.text; } })
      .on("title", { text(t) { if (!found.title) found.titleRaw = (found.titleRaw || "") + t.text; } })
      .on("script[type='application/ld+json']", {
        text(t) {
          ldBuf += t.text;
          if (t.lastInTextNode) { ldJson.push(ldBuf); ldBuf = ""; }
        },
      })
      .transform(res)
      .arrayBuffer();
  } catch (e) {
    console.log("preview fetch failed", String(e));
    return { title: null, image: null, price: null, blocked: true };
  }

  // Structured product data (most shops include this).
  for (const raw of ldJson) {
    try {
      const product = findProduct(JSON.parse(raw));
      if (!product) continue;
      if (!found.ldTitle && product.name) found.ldTitle = String(product.name);
      const img = Array.isArray(product.image) ? product.image[0] : product.image;
      const imgUrl = typeof img === "string" ? img : img?.url;
      if (imgUrl) images.push(imgUrl);
      const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      const p = offer?.price ?? offer?.lowPrice;
      if (p && !found.price) { found.price = String(p); found.currency = found.currency || offer?.priceCurrency; }
    } catch { /* ignore bad JSON */ }
  }

  const image = images.map((s) => absolutize(decodeEntities(s.trim()), finalUrl)).find(Boolean) || null;
  const title = decodeEntities(
    (titleBuf.trim() || found.ldTitle || found.ogTitle || found.titleRaw || "").replace(/\s+/g, " ").trim()
  ).slice(0, 200) || null;
  let price = found.price ? String(found.price).trim() : null;
  if (price && /^\d+(\.\d+)?$/.test(price)) {
    const sym = { USD: "$", CAD: "$", AUD: "$", GBP: "£", EUR: "€" }[String(found.currency || "USD").toUpperCase()] || "";
    price = `${sym}${Number(price).toFixed(2)}`;
  }
  const blocked = !image && /robot|captcha|access denied|just a moment/i.test(title || "");
  return { title: blocked ? null : title, image, price: price && price.length < 40 ? price : null, blocked };
}

function findProduct(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) { const p = findProduct(n); if (p) return p; }
    return null;
  }
  const type = node["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return node;
  if (node["@graph"]) return findProduct(node["@graph"]);
  if (node.mainEntity) return findProduct(node.mainEntity);
  return null;
}

function absolutize(src, base) {
  try {
    const u = new URL(src, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch { return null; }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

function cleanText(value, max, multiline = false) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  s = multiline ? s.replace(/\r\n/g, "\n") : s.replace(/\s+/g, " ");
  return s.trim().slice(0, max);
}

function cleanUrl(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString().slice(0, 2000);
  } catch { return null; }
}
