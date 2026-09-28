# TAPX

A full-stack tap-to-earn game: static HTML/CSS/JavaScript frontend, Supabase
(PostgreSQL + Auth + Row Level Security) backend, and compliant, clearly
labelled advertising placements.

No build step. No framework. Deploy the folder to any static host.

---

## 1. Requirements

| Requirement | Notes |
| --- | --- |
| A static web host | Netlify, Vercel, Cloudflare Pages, GitHub Pages, or any web server. |
| A Supabase project | <https://supabase.com> - the free tier is enough. |
| Node.js (optional) | Only for `npx serve` while developing. The app itself needs no Node. |
| Adsterra account (optional) | Only needed if you want to show ads. The game works fully without it. |

---

## 2. Setup

### Step 1 - Create the database

Open your Supabase project -> **SQL Editor** -> **New query**, then run the three
files **in this order**:

1. `supabase/schema.sql` - tables, indexes, trigger functions, RPCs, RLS
   policies and grants. Already includes the full set of policies, so it can be
   run on its own.
2. `supabase/policies.sql` - the same policies in standalone form. Safe to skip
   if you just ran `schema.sql`; useful later to re-apply or audit policies
   without rebuilding the schema. Re-running it is harmless.
3. `supabase/seed.sql` - default upgrades, milestones, ad placements, app
   settings and a welcome announcement. Safe to re-run (it upserts).

All three files are idempotent, so you can run them again at any time.

### Step 2 - Add your Supabase keys

Open `js/config.js` and replace the two placeholders:

```js
const SUPABASE_URL = "YOUR_PROJECT_URL";
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";
```

Supabase Dashboard -> **Project Settings** -> **API**:

- **Project URL** -> `SUPABASE_URL`
- **anon public** key (or the newer **publishable** key) -> `SUPABASE_ANON_KEY`

The anon/publishable key is designed for browsers and is safe to ship **only
because every table in this project has Row Level Security enabled**. RLS is not
optional here - without it the anon key would be a full data breach.

> **Never** put the `service_role` key, the Supabase database password, or any
> Adsterra private/adsterra-direct secret in this repository or in any frontend
> file. This project never needs them.

Optionally pin the client library version in `CONFIG.supabaseCdn` before going
live, e.g. `@supabase/supabase-js@2.49.4` instead of the floating `@2`.

### Step 3 - Enable email sign-in

Supabase Dashboard -> **Authentication** -> **Providers** -> **Email**.

- Leave **Confirm email** enabled for production.
- Add your production domain to **Authentication -> URL Configuration -> Site
  URL** and to the **Redirect URLs** allow list, e.g.
  `https://your-domain.com/reset-password.html`. Password-reset emails redirect
  to `reset-password.html`, so that page must be reachable publicly.

### Step 4 - Run it locally

ES modules are blocked by browsers on `file://`, so you must serve the folder over
HTTP:

```bash
# pick one
npx serve .
python -m http.server 8080
php -S localhost:8080
```

Then open <http://localhost:8080/>.

Opening `index.html` by double-clicking shows a setup message instead of the
game; that is intentional.

### Step 5 - Create your first admin

Admin rights are never granted automatically. Sign up once, then in the SQL
Editor:

```sql
-- find your user id
select id, email from auth.users order by created_at desc limit 5;

-- make yourself the owner
insert into public.admin_users (user_id, role)
values ('PASTE-THE-USER-UUID-HERE', 'owner')
on conflict (user_id) do update set role = excluded.role;
```

Sign out, sign back in, and open `admin.html`. From there you can manage users,
coin balances, upgrades, milestones, settings and ad placements, and grant or
revoke the admin role for other accounts.

---

## 3. Advertising (Adsterra)

Ads are **off by default**. The game is fully playable and complete with no ad
network at all.

You do not need to edit any file to run ads. Everything is done in
**Admin → Ads**.

### Setup, in this order

1. Get the official publisher code for a placement from your Adsterra dashboard.
2. In **Admin → Ads**, tick **Ads enabled on the game page** (the master switch).
3. Press **Restore the 5 default placements** if the table is empty.
4. Under **Ad code**, choose the placement (`top`, `stats`, `between`, `inline`
   or `bottom`).
5. Paste the snippet **verbatim** into the textarea and press **Save code**.
6. Switch that placement **ON** in the Placements table. The **Code** column
   turns from `NONE` to `SET`.
7. Reload the game page. The unit appears in the matching visible container.

Turning ads off again is one tick: untick the master switch. Every placement
disappears immediately, with no deploy and no file edit.

### Where each container appears

Five containers, in page order. Each loads **once per page view**.

| Placement | Container | Position in `index.html` |
| --- | --- | --- |
| `top` | `#ad-top` | Directly under the XP card |
| `stats` | `#ad-stats` | Directly under the stats strip, above the XP bar |
| `between` | `#ad-between` | After the tap area, above the disclaimer |
| `inline` | `#ad-inline` | After the disclaimer, above the bottom slot |
| `bottom` | `#ad-bottom` | Above the bottom navigation |

Each container starts with the `hidden` attribute, so a disabled placement never
reserves blank space. The real page order is `#ad-stats`, `#ad-top`, the daily
reward, the tap button, `#ad-between`, `#ad-inline`, `#ad-bottom` - so no unit
ever lands on top of the tap button.

Paste a different official snippet into any slot to run several formats side by
side. Adsterra often under-delivers on a single format, so diversifying usually
earns more than adding further units.

`index.html` still accepts a hand-pasted snippet as a fallback, but you should
not need it. The database value wins whenever both exist.

### Rules this project follows, and that you must keep following

- Only the official Adsterra publisher code goes into that textarea. Never
  invent, guess or hand-write ad code.
- No hidden, invisible, off-screen, or `opacity: 0` ad units.
- No ads on tap, on click, on key press, or on any user interaction.
- No forced auto-refresh and no reload loops. A saved snippet is injected
  **exactly once per page load** and is never re-injected, so a settings refresh
  can never double-count an impression.
- No simulated, self-generated, or incentivised impressions or clicks, no
  self-clicking, and never ask users to click ads in exchange for coins.
- Ads must not obstruct the tap button, the reward button, or navigation.
- Never route users to a placement only to inflate impressions.

`record_ad_event()` is used for your own coarse, rate-limited app-side records of
which slots were viewed (`placement_view`) and which were closed
(`placement_close`). It is **not** an ad-network impression system: the server
rejects unknown or disabled placements and caps one record per placement per
`CONFIG.ads.recordCooldownMs` (60s) per user. Your ad network's own rules and
capping apply on top of that, independently.

### Notes on storing the snippet

- The snippet is stored in `public.ad_placements.code` and is written only
  through the `admin_set_ad_code()` RPC, which calls `require_admin()` in the
  database. A non-admin cannot change it.
- It is rendered verbatim, because a publisher tag is a `<script>` and cannot be
  made to work any other way. **An administrator can therefore already run
  arbitrary JavaScript on this site** — they also control the app name, the
  announcements and every setting. Keep exactly one trusted admin account and
  give it a strong password; this does not widen the existing trust boundary.
- Snippets using `document.write()` are rejected, on save and again at render
  time. Injected after page load they would blank the page. Ask your network for
  the standard `<script>` version. A max of 20,000 characters is enforced.
- The snippet is readable by anyone who can see the page, exactly as it already
  was when it was hard-coded in `index.html`. It is not a secret.
- If a snippet is broken, the app logs a warning and the game keeps working.

### Upgrading an existing install

`schema.sql` is idempotent: simply run it again in the SQL Editor. That adds the
`code` column, the `admin_set_ad_code()` function, its grant, and the
`ads_enabled` setting without touching any existing data, code or role.

---

## 4. How the game works

```
tap  ->  local batch (<= CONFIG.maxBatchTaps, flushed every CONFIG.tapBatchMs)
     ->  rpc process_tap(tap_count, duration_ms, client_combo)
     ->  server re-validates and re-scores the batch
     ->  balances, combo, XP and level are recomputed server-side
     ->  response replaces local state
```

Taps are batched purely to save bandwidth. `process_tap()` is the authority and
enforces the real limits (`game_limits()`):

- Taps faster than `min_tap_interval_ms` (40 ms) are refused.
- A batch is capped at 250 taps.
- The allowed tap count is derived from the elapsed time on the server, so a
  forged or replayed batch cannot mint coins.
- Coins per tap, combo, critical chance, XP curve and level-ups are all computed
  in SQL. The client only animates numbers it has already been told.
- Coins, XP, levels, upgrades, rewards and ad records live in the database.
  Only cosmetic preferences (sound, vibration, last username, onboarding) are
  kept in `localStorage`.

If a request fails, the batch is discarded rather than replayed, and the UI
resyncs from the server. Tapping never accumulates unsynced taps locally.

Progression: `xp_to_next(level) = 100 * level + 25 * level^2`. Upgrades are
`tap_power`, `combo_boost`, `critical_tap` and `bonus_multiplier`, with
`cost(level) = base_cost * growth^level`.

---

## 5. Security model

- **RLS on every table.** No table is readable or writable by a role that has
  no policy for it.
- **Per-user data** (`profiles`, `game_state`, `user_upgrades`,
  `user_milestones`, `daily_rewards`, `ad_events`) is restricted to
  `user_id = auth.uid()`. Admins can read users through SECURITY DEFINER
  functions only, never by reading other people's rows directly.
- **Writes go through RPCs only.** `profiles` and `game_state` are readable by
  the owner but not writable by the client; balances, upgrades, rewards and
  levels can only change via validated SQL functions.
- **Column-level privileges.** Even where a client may update a row, grants are
  limited to cosmetic columns (display name, sound/vibration flags). Coins,
  XP, level, `coins_per_tap`, `total_taps` and combo cannot be written by a user.
- **Guard triggers** (`guard_profile_write`, `guard_game_state_write`,
  `guard_ad_event`) block direct writes and reject rows that are out of range.
- **`is_admin()` is authoritative.** The admin dashboard only *displays* the
  result; every admin RPC calls `require_admin()` server-side, so editing the UI
  grants nothing.
- **`SECURITY DEFINER` functions pin `search_path = public`** and are granted
  `execute` only to the roles that need them.
- `anon` can read only the public catalogue (active upgrades, milestones, ad
  placements, app settings) - this is what the login and game pages need.

### Client-side hardening

`js/security.js` sanitises untrusted text before it reaches `innerHTML`, and all
numbers coming back from the server pass through clamped integer coercion, so a
corrupt or hostile response cannot inject markup or break the UI.

---

## 6. Project layout

```
tapx/
  index.html              game page
  login.html              sign in
  register.html           sign up
  forgot-password.html    request a reset email
  reset-password.html     set a new password
  admin.html              admin dashboard
  privacy.html            privacy policy (template)
  terms.html              terms of service (template)
  css/
    style.css             game UI
    auth.css              auth pages
    admin.css             admin dashboard
  js/
    config.js             credentials + runtime configuration  <- EDIT THIS
    supabase.js           client bootstrap + RPC/table helpers
    auth.js               auth pages, sign-in/up/reset, admin guard
    game.js               tap engine, batching, rendering
    upgrades.js           upgrade list, purchase, costs
    rewards.js            daily reward + milestones
    stats.js              XP, level, rank
    ads.js                ad slot visibility + rate-limited records
    settings.js           header, preferences, announcement
    admin.js              dashboard (admin-only)
    security.js           escaping + clamped number coercion
    ui.js                 shared DOM/toast/modal/sound helpers
  supabase/
    schema.sql            tables, triggers, RPCs, RLS, grants
    policies.sql          standalone RLS policy re-apply
    seed.sql              default content + first-admin instructions
  assets/
    icons/                favicon.svg, icon-192.svg
    sounds/               WebAudio tones are generated, no files needed
```

---

## 7. Administration

`admin.html` tabs:

- **Overview** - user count, 24h signups, total taps, total coins, top players.
- **Users** - search by username, display name or user ID, reveal emails,
  paginate, adjust a user's coins, and grant or revoke admin.
- **Game settings** - upgrades (create/edit/reorder/activate/delete),
  milestones, and app settings: app name, tagline, tap value, daily reward
  table, support email, maintenance mode.
- **Ads** - the master "ads enabled" switch, the ad-code editor (paste, save or
  clear the official snippet per placement), the placements table showing each
  placement's `Code` and `ON`/`OFF` state, and a **Restore the 3 default
  placements** button.

The game has exactly five ad containers, so there is exactly one placement per
`location`. `admin_save_placement()` rejects an unknown location, a duplicate
location, a slug outside `^[a-z0-9_-]{2,32}$` and an empty label, so a
misconfigured placement cannot be saved in the first place. If the placements
table is ever empty, press **Restore the 5 default placements** - it recreates
the five rows and never touches a saved `code` snippet or an `enabled` state.
- **Announcements** - the banner shown on the game page.
- **System** - security notes and client configuration status.

Coin adjustments go through `admin_adjust_coins()`, which requires admin rights
server-side, caps the delta at 1e9, clamps the resulting balance at zero, and
refuses to operate on a non-existent user. The dashboard sends a fixed
`p_reason` of `"admin adjustment"`.

> Known limitation: the reason is echoed back in the RPC response but is not
> persisted anywhere. There is no admin audit log table in this project. If you
> need one for compliance, add an `admin_audit` table with an insert-only policy
> and write to it from the `admin_*` functions.

**Before going live:** replace `support@example.com` in Settings, and fill in the
real company/contact details in `privacy.html` and `terms.html`. Both are clearly
marked templates and are not legal advice.

---

## 8. Verification performed

- `schema.sql`, `policies.sql` and `seed.sql` parse cleanly against the real
  PostgreSQL grammar (193 / 111 / 5 statements).
- All 36 PL/pgSQL function bodies parse cleanly.
- Every `GRANT`/`REVOKE` signature matches the function it refers to.
- All 26 `rpc(...)` calls made by the frontend resolve to a function that exists
  and is granted to the correct role.
- Every direct table read in the frontend is covered by a matching RLS select
  policy.
- All 12 JavaScript modules pass `node --check`, and every ES module import,
  page asset and DOM id referenced by the code resolves.
- Every entry in `LOCATION_TO_CONTAINER` has a matching container in
  `index.html` and vice versa, all five start `hidden`, and all five carry
  `aria-label="Advertisement"`. A missing entry here is the failure mode where a
  placement is enabled but silently never renders.
- The ad-snippet renderer was exercised in a real DOM: scripts execute, `src` /
  `async` / `data-*` attributes survive, the "Sponsored" label is never wiped,
  previous content is replaced rather than stacked, `document.write()` and
  oversized snippets are refused, and 5 consecutive config refreshes still load
  the unit exactly once.

Not verified locally, because it needs a real Supabase project: the SQL has not
been executed against a live database, and the browser flows (sign-up, sign-in,
tapping, upgrades, rewards, admin) have not been run end to end. Run the smoke
test in step 9 after you create the project.

---

## 9. Smoke test after setup

1. `index.html` shows the setup message, not the game. -> keys still missing.
2. Sign up, then confirm the email if enabled.
3. Sign in -> the game loads with 0 coins and combo 0.
4. Tap ~20 times -> coins and combo rise, and the header shows a synced state.
5. Reload -> the balance persists (it came from the database, not localStorage).
6. Buy the cheapest upgrade -> level goes up and coins drop by the quoted cost.
7. Claim the daily reward -> blocked, then credited after the claim.
8. Claim a milestone once it is reached -> credited; claiming again is refused.
9. `admin.html` as a normal user -> access denied.
10. `admin.html` as the owner -> all sections load; adjust a user's coins and
    confirm the change on the game page.
11. With a second browser profile, confirm you cannot see or change the first
    user's rows (RLS is doing its job).
12. Ads still hidden -> the master switch and the placements are off. Tick
    **Ads enabled**, paste the official code, tick the placement ON, and confirm
    the unit renders visibly, does not shift the tap button, and does not reload
    on a tap.
13. Confirm no `service_role` key and no Adsterra private secret appear in any
    deployed file.
