# 🏦 papa-bank

**English · [中文](README.zh.md)**

A pretend "bank" that helps kids learn about money and the habit of saving.

<p align="center"><img src="screenshots/main.svg" alt="papa-bank main screen" width="320"></p>

**Features**
- Deposit, withdraw (blocked when the balance is too low), and a transaction history
- Set an annual interest rate with **automatic interest** (compound; it's back-filled on the next open even if the app was closed)
- Multiple **savers** (tabs at the top, up to 20)
- **Savings goals**: give each saver a goal (e.g. "buy LEGO — NT$500"); a progress bar shows on the balance card and celebrates when reached 🎉
- **Backup**: from ⚙️ Settings, export a CSV (opens in Excel), export a full JSON backup, or restore one
- **Monthly balance trend chart** and a **monthly summary** (in / interest / out / net)
- Selectable **decimal places** (integer / 1 / 2)
- Automatic **pagination** when there are many records
- One-tap **English / 中文** switch (top-right "中/EN")
- **Kid / Parent modes**: read-only by default; enter a password to edit (see below)

**Modes**
- Pure front-end, zero install, zero cost.
- **Local mode**: just use it; data lives in this device's browser.
- **Cloud sync mode**: after pasting a free Firebase config, manage on a PC and view on a phone — all devices share one dataset.

---

## 1. Get started (local mode)

Just open `index.html` in a browser (double-click it).

> Chrome / Edge recommended. Data is stored in this browser, so it's lost if you switch devices or clear browser data.
> For cross-device sync and permanent storage, do the Firebase setup in section 3.

### How to teach a kid
1. Tap **＋ Add saver**, enter a name and an annual rate (e.g. 5%).
2. When giving allowance, tap **＋ Deposit** and add a note (e.g. "dishwashing reward").
3. To buy something, tap **－ Withdraw** (overdrawing is blocked, teaching them to live within their means).
4. In **⚙️ Settings**, change the interest frequency to **Per minute (fast test)** to watch interest grow within minutes — great for explaining **compound interest**; switch it back to **Monthly** afterwards.

---

## 2. Want it online / on a phone?

Upload this folder to any free static host (pick one):
- **Firebase Hosting** (same project as the sync below — easiest)
- GitHub Pages / Cloudflare Pages / Netlify / Vercel

On a phone, use the browser's "Add to Home Screen" so it behaves like an app.

> Already configured for Firebase Hosting: run `firebase deploy --only hosting` (or just double-click `deploy.cmd` on Windows).

---

## 3. Enable multi-device sync (free Firebase)

> Usage is tiny — it stays within Firebase's free Spark plan, free long-term, no credit card needed.

1. Go to <https://console.firebase.google.com>, sign in with a Google account, click **Add project**.
2. Copy **`firebase-config.example.js`** to **`firebase-config.js`** (this real-config file is gitignored, so your keys never go to GitHub). Then in the project: gear icon → **Project settings → General** → under "Your apps" pick **Web (</>)**, give it a nickname, create it, and you'll see a `firebaseConfig`. Copy `apiKey / authDomain / projectId / appId` into **`firebase-config.js`**.
3. Left menu **Build → Authentication → Get started → enable "Email/Password"**.
4. Left menu **Build → Firestore Database → Create database** (production mode / a region near you).
5. In the Firestore **Rules** tab, paste and publish this (only signed-in users can access their own data):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /banks/{docId} {
         allow read, write: if request.auth != null
           && docId.matches(request.auth.uid + '_.*');
       }
     }
   }
   ```

6. Reload `index.html`; a login screen appears. Enter a family email and password (≥6 chars) — **the first sign-in auto-registers**. All devices then log in with the same credentials and share one dataset.

When done, the top-right badge changes from "Local" to "Synced".

---

## Files
| File | Purpose |
|------|---------|
| `index.html` | Markup |
| `styles.css` | Styles |
| `app.js` | All logic (deposit/withdraw, interest, history, charts, pagination, lock, sync) |
| `i18n.js` | English / Chinese dictionary |
| `firebase-config.js` | Cloud sync config (empty = local mode) |
| `deploy.cmd` | One-click deploy to Firebase Hosting (Windows) |

## Kid mode / Parent mode
The app is **read-only (kid mode) by default**: you can view balance, history, and trends, but **cannot** deposit/withdraw, change settings, or add savers.

1. **First time**: tap **🔒** (top-right) → set a "parent password" → you're now in parent mode.
2. **After that**: tap **🔒** → enter the parent password → parent mode unlocks deposit, withdraw, settings, and adding savers.
3. Change the password: in parent mode tap **⚙️ Settings**.
4. Back to kid mode: tap **🔓** to lock manually, or it auto-locks after **3 minutes idle**, or on **reload / reopen**.

> **Honest security note**: parent mode is session-only — reopening requires re-auth, which stops a typical child. But the password is stored in the data, so **someone who knows DevTools could bypass it**. For true database-level read-only, create a separate child account in cloud mode and adjust the Firestore rules.
> Also: **if you forget the parent password**, in local mode you can only reset by clearing browser data (which loses the data too); in cloud mode you can edit the record in the Firebase console.

## How is interest calculated?
Each interest period (monthly / daily / per-minute-test), `current balance × annual rate ÷ periods` is added to the account. Because interest is folded into the principal, it **compounds**. Interest is computed from timestamps, so even if the app was closed, the next open back-fills everything that was due.

## Limits & safety notes (honest)
- **Up to 20 savers**; max single amount 1 billion; max annual rate 1000% (to prevent runaway typos).
- **Monthly summary / trend chart show the last 24 months only**, so the list can't grow forever.
- Amount inputs reject blanks, negatives, `Infinity`, and oversized numbers; corrupt data falls back to a clean initial state instead of a blank screen.
- **Kid mode (read-only) is the default**; a parent password is required to enter editable parent mode (auto-reverts on reopen or after 3 minutes idle). This stops a typical child but **someone who knows DevTools could bypass it** — for real database-level read-only, add a child account in cloud mode + adjust Firestore rules. See "Kid mode / Parent mode".
- **Cloud mode allows sign-up by default**: anyone could register an account in your Firebase project (they can only see their own data, never yours). If that bothers you, disable public sign-up in the Firebase console under **Authentication → Settings**.
