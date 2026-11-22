# 🎄 Christmas Wishlist

A small, private wishlist site for family and friends, hosted free on Cloudflare.

- **List owners** (you two) log in with the *owner password* to create lists (one per person), and add, edit or delete items.
- Paste a product link and the site **fetches the picture, name and price** automatically. Every item has a free-text **details** box (size, color and so on), a price, and a ⭐ *Most wanted* flag.
- **Family** log in with the *family password* to browse and tap **"I bought this"**, optionally leaving their name so others can coordinate.
- **Surprises are protected.** Owners never see what's been bought on lists marked secret. That's enforced on the server, so even the browser's developer tools won't show it. Each list has a switch, so you can turn secrecy *off* for the kids' lists and see what's already covered.
- **Buying for each other:** on the family view, each phone or computer has a **"This is me"** picker that hides purchases on that person's own list. So your spouse can log in with the family password, set "This is me: Spouse", and safely mark gifts on your list.

Everything fits in Cloudflare's free tier (Pages + Pages Functions + D1 database).

---

## Deploying on Cloudflare (about 10 minutes, all in the browser)

### 1. Get the code onto your main branch
Merge this branch into `main` on GitHub (or pick this branch as the production branch in step 3).

### 2. Create the database
1. Sign up or log in at <https://dash.cloudflare.com> (the free plan is fine).
2. In the left sidebar, open **Storage & Databases → D1 SQL Database → Create**.
3. Name it `wishlist` and click **Create**. You don't need to run any SQL; the tables are created automatically.

### 3. Create the Pages site
1. In the sidebar, open **Workers & Pages → Create → Pages → Connect to Git** (sometimes labelled "Import an existing Git repository").
2. Authorize GitHub and select the **wishlist** repository.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `public`
4. Click **Save and Deploy**. The first deploy finishes, but the site will say it's not configured yet. That's expected.

### 4. Connect the database and set passwords
In your new Pages project, open **Settings**:

1. **Bindings → Add → D1 database.** Variable name: `DB`. Database: `wishlist`. Save.
2. **Variables and Secrets → Add** (for Production):

   | Type | Name | Value |
   |---|---|---|
   | Secret | `OWNER_PASSWORD` | the password you two will use |
   | Secret | `FAMILY_PASSWORD` | a different, easy password for family |
   | Text *(optional)* | `SITE_TITLE` | e.g. `The Kenneth Family Wishlist` |

   The two passwords **must be different**.

3. Go to **Deployments**, open the latest deployment's **⋯** menu and choose **Retry deployment**, so the settings take effect.

### 5. Use it
- Open `https://<your-project>.pages.dev`, log in with the owner password, click **Create the first list**, and add items.
- Send family the link and the **family password**.
- Optional: **Custom domains** in the Pages project lets you use your own domain.

Changing either password logs everyone out, so they'll need the new one.

---

## Tips
- **If a store won't show a picture:** some stores (Amazon especially) occasionally block automatic lookups. Open the product page, right-click (or long-press) the photo, choose **Copy image address**, and paste it into **Picture link**.
- Family see a "Hide bought items" toggle to focus on what's left.
- The page refreshes its data when you switch back to the tab, so you'll see others' updates.

## Running locally (optional, for tinkering)
```bash
npm install
printf 'FAMILY_PASSWORD=family\nOWNER_PASSWORD=owner\n' > .dev.vars
npm run dev     # http://localhost:8788
```

## How it's built
- `public/`: the static site (plain HTML, CSS and JS, no build step).
- `functions/api/[[path]].js`: the API (login, lists, items, claims and link previews), running as a Cloudflare Pages Function with a D1 (SQLite) database.
- Logins use an HTTP-only signed cookie that lasts 120 days.
