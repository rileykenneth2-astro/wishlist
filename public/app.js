// Christmas Wishlist frontend (no build step, plain JS).

const $ = (sel) => document.querySelector(sel);
// localStorage can throw in private mode; never let that break the page.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const state = {
  role: null,
  title: "Our Christmas Wishlist",
  people: [],
  items: [],
  current: null,
  me: store.get("wl_me") || "",
  hideBought: store.get("wl_hide_bought") === "1",
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== "login") { showLogin(); throw new Error(data.error || "Please log in."); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function boot() {
  makeSnow();
  try {
    const me = await api("me");
    state.title = me.title;
    document.title = me.title;
    document.querySelectorAll(".site-title").forEach((el) => (el.textContent = me.title));
    if (me.role) { state.role = me.role; await loadData(); showApp(); }
    else showLogin();
  } catch (e) {
    showLogin(e.message);
  }
}

async function loadData() {
  const data = await api("data");
  state.role = data.role;
  state.people = data.people;
  state.items = data.items;
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("list");
  const ids = state.people.map((p) => p.id);
  if (fromHash && ids.includes(fromHash)) state.current = fromHash;
  if (!ids.includes(state.current)) state.current = ids[0] || null;
  if (state.me && !ids.includes(state.me)) state.me = "";
  render();
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function showLogin(msg) {
  $("#app-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
  $("#login-error").textContent = msg && msg !== "Please log in." ? msg : "";
  setTimeout(() => $("#login-password").focus(), 50);
}

function showApp() {
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter || $("#login-form button");
  btn.disabled = true;
  $("#login-error").textContent = "";
  try {
    await api("login", { method: "POST", body: { password: $("#login-password").value } });
    $("#login-password").value = "";
    await loadData();
    showApp();
  } catch (err) {
    $("#login-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("logout", { method: "POST" }).catch(() => {});
  state.role = null;
  showLogin();
});

function isOwner() { return state.role === "owner"; }

// Can the current viewer see whether items on this person's list are bought?
function claimsVisible(person) {
  if (!person) return false;
  if (isOwner()) return !person.hide_claims;
  return state.me !== person.id;
}

function render() {
  document.body.classList.toggle("is-owner", isOwner());
  document.querySelectorAll(".owner-only").forEach((el) => el.classList.toggle("hidden", !isOwner()));
  $("#role-badge").textContent = isOwner() ? "List owner" : "Family";

  // "This is me" picker (family only)
  const picker = $("#me-picker");
  $("#me-picker-wrap").classList.toggle("hidden", isOwner() || state.people.length === 0);
  picker.replaceChildren(
    new Option("Just shopping", ""),
    ...state.people.map((p) => new Option(p.name, p.id))
  );
  picker.value = state.me;

  renderTabs();

  const person = state.people.find((p) => p.id === state.current);
  $("#empty-people").classList.toggle("hidden", !!person);
  $("#list-section").classList.toggle("hidden", !person);
  $("#empty-add-person").classList.toggle("hidden", !isOwner());
  $("#empty-people-text").textContent = isOwner()
    ? "Create a list for each person, such as one for you and one for your spouse, then start adding gift ideas."
    : "Nothing here yet. Check back soon!";
  if (!person) { $("#banner").classList.add("hidden"); return; }

  const visible = claimsVisible(person);
  const items = state.items.filter((i) => i.person_id === person.id);
  const boughtCount = visible ? items.filter((i) => i.claimed).length : 0;

  $("#list-name").textContent = `${person.name}'s list`;
  $("#list-sub").textContent = items.length
    ? `${items.length} item${items.length === 1 ? "" : "s"}` + (visible ? ` · ${boughtCount} bought` : "")
    : "";
  $("#hide-bought").closest("label").classList.toggle("hidden", !visible);
  $("#hide-bought").checked = state.hideBought;

  // Banner
  const banner = $("#banner");
  let bannerText = "";
  if (isOwner() && person.hide_claims) {
    bannerText = "🤫 Purchases on this list are kept secret from list owners, so you won't see what's been bought. If you want to buy something for this person yourself, log in with the family password.";
  } else if (!isOwner() && state.me === person.id) {
    bannerText = "🙈 This is your list, so purchases are hidden to keep the surprise.";
  } else if (!isOwner()) {
    bannerText = "Found something to buy? Tap “I bought this” so nobody else buys it too. The list owners won't see it.";
  }
  banner.textContent = bannerText;
  banner.classList.toggle("hidden", !bannerText);

  // Sort: unbought first (when visible), keep most-wanted on top
  let shown = items.slice();
  if (visible) {
    shown.sort((a, b) => Number(a.claimed) - Number(b.claimed));
    if (state.hideBought) shown = shown.filter((i) => !i.claimed);
  }

  $("#grid").replaceChildren(...shown.map((it) => renderCard(it, person, visible)));
  $("#empty-items").classList.toggle("hidden", shown.length > 0);
  $("#empty-items-text").textContent = items.length
    ? "Everything on this list has been bought! 🎉"
    : isOwner() ? "No items yet. Click “+ Add item” and paste a link." : "No items on this list yet.";
}

function renderTabs() {
  const tabs = state.people.map((p) => {
    const b = el("button", { className: "tab", role: "tab", "aria-selected": String(p.id === state.current) });
    b.append(p.name);
    const n = state.items.filter((i) => i.person_id === p.id).length;
    b.append(el("span", { className: "count", textContent: String(n) }));
    b.addEventListener("click", () => selectPerson(p.id));
    return b;
  });
  if (isOwner()) {
    const add = el("button", { className: "tab tab-add", textContent: "+ New list" });
    add.addEventListener("click", () => openPersonDialog(null));
    tabs.push(add);
  }
  $("#tabs").replaceChildren(...tabs);
}

function selectPerson(id) {
  state.current = id;
  history.replaceState(null, "", `#list=${id}`);
  render();
}

function renderCard(it, person, visible) {
  const card = el("article", { className: "card" });
  const bought = visible && it.claimed;
  if (bought) card.classList.add("bought");

  // Picture
  const thumb = el(it.url ? "a" : "div", { className: "thumb" });
  if (it.url) Object.assign(thumb, { href: it.url, target: "_blank", rel: "noopener noreferrer" });
  thumb.append(makeImage(it.image_url));
  card.append(thumb);
  if (it.most_wanted) card.append(el("span", { className: "pill", textContent: "⭐ Most wanted" }));
  if (bought) card.append(el("span", { className: "pill pill-bought", textContent: "✓ Bought" }));

  const body = el("div", { className: "card-body" });
  const title = el("div", { className: "card-title" });
  if (it.url) title.append(el("a", { href: it.url, target: "_blank", rel: "noopener noreferrer", textContent: it.title }));
  else title.textContent = it.title;
  body.append(title);

  const meta = el("div", { className: "card-meta" });
  if (it.price) meta.append(el("span", { className: "price", textContent: it.price }));
  if (it.url) meta.append(el("span", { textContent: hostOf(it.url) }));
  if (meta.childNodes.length) body.append(meta);

  if (it.notes) body.append(el("div", { className: "notes", textContent: it.notes }));

  // Buying status
  if (visible) {
    if (it.claimed) {
      const row = el("div", { className: "claim-row" });
      row.append(el("span", { textContent: it.claimed_by ? `✓ Bought by ${it.claimed_by}` : "✓ Someone bought this" }));
      const undo = el("button", { className: "link-btn", textContent: "Undo" });
      undo.addEventListener("click", () => unclaim(it));
      row.append(undo);
      body.append(row);
    } else {
      const actions = el("div", { className: "card-actions" });
      const buy = el("button", { className: "btn btn-green btn-sm", textContent: "🎁 I bought this" });
      buy.addEventListener("click", () => openClaim(it));
      actions.append(buy);
      body.append(actions);
    }
  }

  if (isOwner()) {
    const actions = el("div", { className: "card-actions" });
    const edit = el("button", { className: "btn btn-ghost btn-sm", textContent: "Edit" });
    edit.addEventListener("click", () => openItemDialog(it));
    const del = el("button", { className: "btn btn-danger-ghost btn-sm", textContent: "Delete" });
    del.addEventListener("click", () => deleteItem(it, person));
    actions.append(edit, del);
    body.append(actions);
  }

  card.append(body);
  return card;
}

function makeImage(src) {
  const fallback = () => el("span", { className: "placeholder", textContent: "🎁" });
  if (!src) return fallback();
  const img = el("img", { src, alt: "", loading: "lazy", referrerPolicy: "no-referrer", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(fallback()));
  return img;
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------
let claimTarget = null;
function openClaim(it) {
  claimTarget = it;
  $("#claim-item-name").textContent = it.title;
  $("#claim-name").value = store.get("wl_buyer") || "";
  $("#claim-error").textContent = "";
  $("#claim-dialog").showModal();
}

$("#claim-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#claim-name").value.trim();
  store.set("wl_buyer", name);
  try {
    await api(`items/${claimTarget.id}/claim`, { method: "POST", body: { name } });
    $("#claim-dialog").close();
    toast("Marked as bought. Nice! 🎄");
  } catch (err) {
    $("#claim-error").textContent = err.message;
  }
  await loadData().catch(() => {});
});

async function unclaim(it) {
  const who = it.claimed_by ? ` by ${it.claimed_by}` : "";
  if (!confirm(`Un-mark “${it.title}” as bought${who}? Only do this if it was marked by mistake.`)) return;
  try {
    await api(`items/${it.id}/claim`, { method: "DELETE" });
    toast("Marked as not bought");
  } catch (err) { toast(err.message); }
  await loadData().catch(() => {});
}

// ---------------------------------------------------------------------------
// Item editor (owners)
// ---------------------------------------------------------------------------
let editing = null;
let autoFilled = { title: false, price: false, image: false };

$("#add-item-btn").addEventListener("click", () => openItemDialog(null));

function openItemDialog(it) {
  editing = it;
  autoFilled = { title: false, price: false, image: false };
  $("#item-dialog-title").textContent = it ? "Edit item" : "Add an item";
  $("#f-url").value = it?.url || "";
  $("#f-title").value = it?.title || "";
  $("#f-price").value = it?.price || "";
  $("#f-image").value = it?.image_url || "";
  $("#f-notes").value = it?.notes || "";
  $("#f-most").checked = !!it?.most_wanted;
  $("#f-person").replaceChildren(...state.people.map((p) => new Option(p.name, p.id)));
  $("#f-person").value = it?.person_id || state.current;
  $("#fetch-status").textContent = "";
  $("#item-error").textContent = "";
  updatePreview();
  $("#item-dialog").showModal();
  if (!it) $("#f-url").focus();
}

function updatePreview() {
  const src = $("#f-image").value.trim();
  $("#f-preview").replaceChildren(makeImage(src));
}

$("#f-image").addEventListener("input", () => { autoFilled.image = false; updatePreview(); });
$("#f-title").addEventListener("input", () => (autoFilled.title = false));
$("#f-price").addEventListener("input", () => (autoFilled.price = false));
$("#fetch-btn").addEventListener("click", () => fetchDetails(true));
$("#f-url").addEventListener("paste", () => setTimeout(() => fetchDetails(false), 0));
$("#f-url").addEventListener("change", () => fetchDetails(false));

let lastFetched = "";
async function fetchDetails(force) {
  const url = $("#f-url").value.trim();
  if (!url || (!force && url === lastFetched)) return;
  lastFetched = url;
  const status = $("#fetch-status");
  const btn = $("#fetch-btn");
  status.textContent = "Looking up the link…";
  btn.disabled = true;
  try {
    const p = await api(`preview?url=${encodeURIComponent(url)}`);
    if ($("#f-url").value.trim() !== url) return; // user changed it meanwhile
    const fill = (field, input, value) => {
      if (value && (!input.value.trim() || autoFilled[field])) { input.value = value; autoFilled[field] = true; }
    };
    fill("title", $("#f-title"), p.title);
    fill("price", $("#f-price"), p.price);
    fill("image", $("#f-image"), p.image);
    updatePreview();
    if (p.image) status.textContent = "Got it! Check the details below.";
    else if (p.blocked) status.textContent = "That store didn't let us peek, so paste a picture link below (see the tip).";
    else status.textContent = "Couldn't find a picture. You can paste one below (see the tip).";
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

$("#item-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    url: $("#f-url").value.trim(),
    title: $("#f-title").value.trim(),
    price: $("#f-price").value.trim(),
    image_url: $("#f-image").value.trim(),
    notes: $("#f-notes").value,
    most_wanted: $("#f-most").checked,
    person_id: $("#f-person").value,
  };
  const save = $("#item-save");
  save.disabled = true;
  try {
    if (editing) await api(`items/${editing.id}`, { method: "PATCH", body });
    else await api("items", { method: "POST", body });
    $("#item-dialog").close();
    toast(editing ? "Saved" : "Added to the list 🎁");
    state.current = body.person_id;
    await loadData();
  } catch (err) {
    $("#item-error").textContent = err.message;
  } finally {
    save.disabled = false;
  }
});

async function deleteItem(it, person) {
  const extra = person.hide_claims ? " If someone already bought it, it will disappear for them too." : "";
  if (!confirm(`Delete “${it.title}”?${extra}`)) return;
  try {
    await api(`items/${it.id}`, { method: "DELETE" });
    toast("Deleted");
  } catch (err) { toast(err.message); }
  await loadData().catch(() => {});
}

// ---------------------------------------------------------------------------
// People (owners)
// ---------------------------------------------------------------------------
let editingPerson = null;
$("#person-settings-btn").addEventListener("click", () =>
  openPersonDialog(state.people.find((p) => p.id === state.current))
);
$("#empty-add-person").addEventListener("click", () => openPersonDialog(null));

function openPersonDialog(p) {
  editingPerson = p;
  $("#person-dialog-title").textContent = p ? "List settings" : "New list";
  $("#p-name").value = p?.name || "";
  $("#p-hide").checked = p ? p.hide_claims : true;
  $("#p-delete").classList.toggle("hidden", !p);
  $("#person-error").textContent = "";
  $("#person-dialog").showModal();
  $("#p-name").focus();
}

$("#person-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: $("#p-name").value.trim(), hide_claims: $("#p-hide").checked };
  if (editingPerson && editingPerson.hide_claims && !body.hide_claims) {
    if (!confirm("Turning this off will show you what's already been bought on this list. Continue?")) return;
  }
  try {
    if (editingPerson) {
      await api(`people/${editingPerson.id}`, { method: "PATCH", body });
    } else {
      const res = await api("people", { method: "POST", body });
      state.current = res.id;
    }
    $("#person-dialog").close();
    await loadData();
  } catch (err) {
    $("#person-error").textContent = err.message;
  }
});

$("#p-delete").addEventListener("click", async () => {
  const p = editingPerson;
  const n = state.items.filter((i) => i.person_id === p.id).length;
  if (!confirm(`Delete ${p.name}'s list and its ${n} item${n === 1 ? "" : "s"}? This can't be undone.`)) return;
  try {
    await api(`people/${p.id}`, { method: "DELETE" });
    $("#person-dialog").close();
    state.current = null;
    await loadData();
  } catch (err) {
    $("#person-error").textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Misc UI
// ---------------------------------------------------------------------------
$("#me-picker").addEventListener("change", (e) => {
  state.me = e.target.value;
  store.set("wl_me", state.me);
  render();
});

$("#hide-bought").addEventListener("change", (e) => {
  state.hideBought = e.target.checked;
  store.set("wl_hide_bought", state.hideBought ? "1" : "0");
  render();
});

document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => b.closest("dialog").close())
);

// Refresh when coming back to the tab so you see others' changes.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.role && !document.querySelector("dialog[open]")) {
    loadData().catch(() => {});
  }
});

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function el(tag, props = {}) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.includes("-") || k === "role") node.setAttribute(k, v);
    else node[k] = v;
  }
  return node;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function makeSnow() {
  const snow = $("#snow");
  const flakes = window.innerWidth < 600 ? 14 : 28;
  for (let i = 0; i < flakes; i++) {
    const f = el("span", { className: "flake", textContent: "❄" });
    f.style.left = `${Math.random() * 100}%`;
    f.style.fontSize = `${8 + Math.random() * 12}px`;
    f.style.animationDuration = `${10 + Math.random() * 14}s`;
    f.style.animationDelay = `${-Math.random() * 20}s`;
    f.style.setProperty("--drift", `${(Math.random() - 0.5) * 80}px`);
    snow.append(f);
  }
}

boot();
