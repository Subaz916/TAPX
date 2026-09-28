-- =============================================================================
-- TAPX - make-me-admin.sql
-- =============================================================================
-- PURPOSE
--   Grants you access to admin.html. This is a SEPARATE, STANDALONE file:
--   you only need to run it ONCE, after schema.sql / policies.sql / seed.sql.
--   It does not create or modify any table, function, policy or grant.
--
-- HOW TO RUN
--   Supabase Dashboard -> SQL Editor -> New query -> paste this file -> Run.
--   You must be signed in to the site FIRST, so that a row for you exists in
--   auth.users. Run this as the "postgres" role in the SQL Editor.
--
--   This file only INSERTs into public.admin_users. It never touches
--   service_role keys, auth.users passwords, or any other table.
--
-- PRE-FILLED FOR
--   de9d7ddf-1584-4911-81b0-1014ff77cbf4
--
-- ROLES (check constraint in schema.sql: admin | owner | moderator)
--   owner     - full access, can grant/revoke admin for other users
--   admin     - full access, same as owner in this project
--   moderator - full access, same as owner in this project
--   NOTE: this project does not currently differentiate the three roles.
--         Any row in admin_users = full admin. Use "owner" for yourself.
--
-- IS IT SAFE TO RE-RUN?
--   Yes. Every statement is idempotent: re-running just resets the role.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1 - Grant admin to the pre-filled user id
-- -----------------------------------------------------------------------------

insert into public.admin_users (user_id, role)
values ('de9d7ddf-1584-4911-81b0-1014ff77cbf4', 'owner')
on conflict (user_id) do update
  set role = excluded.role;


-- -----------------------------------------------------------------------------
-- STEP 2 - Verify it worked
--   You want to see exactly one row: de9d7ddf-...-1014ff77cbf4 | owner
-- -----------------------------------------------------------------------------

select au.user_id, au.role, au.created_at, u.email
  from public.admin_users au
  left join auth.users u on u.id = au.user_id
 order by au.created_at;


-- -----------------------------------------------------------------------------
-- STEP 3 - Confirm the matching account exists
--   If this returns 0 rows, you have NOT signed up yet: sign up at
--   register.html first, then re-run this file.
-- -----------------------------------------------------------------------------

select id, email, created_at
  from auth.users
 where id = 'de9d7ddf-1584-4911-81b0-1014ff77cbf4';


-- -----------------------------------------------------------------------------
-- STEP 4 - Open the panel
--   No re-login is required. is_admin() reads public.admin_users live, so the
--   next page load is enough. Just open:
--
--       https://YOUR-DOMAIN/admin.html
--
--   If you were signed out you are redirected to login.html?next=admin.html
--   and land back on the panel after signing in.
-- -----------------------------------------------------------------------------

-- Optional: grant admin to someone else. Replace the UUID, or find it with:
--   select id, email from auth.users order by created_at desc;
--
-- insert into public.admin_users (user_id, role)
-- values ('PASTE-THE-OTHER-USER-UUID-HERE', 'admin')
-- on conflict (user_id) do update set role = excluded.role;


-- -----------------------------------------------------------------------------
-- STEP 5 - Revoke access (only if you need to remove it later)
--   The on delete cascade in schema.sql means deleting the auth.users row
--   also removes the admin_users row automatically, so this is only needed
--   to demote a user who still has an account.
-- -----------------------------------------------------------------------------

-- delete from public.admin_users
--  where user_id = 'de9d7ddf-1584-4911-81b0-1014ff77cbf4';


-- =============================================================================
-- TROUBLESHOOTING
-- =============================================================================
--
-- A) You open admin.html and get bounced straight back to the game page
--    with the message "Administrator access is required for that page."
--
--    Most likely cause: js/config.js still contains the placeholders
--
--        const SUPABASE_URL = "YOUR_PROJECT_URL";
--        const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";
--
--    The is_admin() RPC then fails, isAdmin() catches the error and returns
--    false, and js/admin.js redirects you. Open the browser console and look
--    for:  [auth] admin check failed
--
--    Fix: paste your real Project URL and anon/publishable key into
--    js/config.js, then hard-refresh (Ctrl+F5) so the module is not cached.
--
-- B) The page is stuck on "Verifying access..."
--    The browser cannot reach the Supabase CDN listed in CONFIG.supabaseCdn
--    (jsdelivr / esm.sh / unpkg), or you are offline. Check the console for
--    a failed dynamic import.
--
-- C) STEP 3 returns 0 rows
--    You have not signed up yet, or you copied the wrong UUID. Sign up at
--    register.html, then re-run STEP 3 to list your real id and email.
--
-- D) "duplicate key value violates unique constraint admin_users_pkey"
--    You should not see this, because the insert uses ON CONFLICT. If you see
--    it, you edited the UUID slightly. Copy it again from STEP 3.
--
-- E) Nothing happens after a successful run
--    is_admin() is a normal SQL function with no caching, so a reload is
--    enough. If it still fails, sign out and sign back in to force a fresh
--    session, then re-open admin.html.
--
-- =============================================================================
-- End of make-me-admin.sql
-- =============================================================================
