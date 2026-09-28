-- =============================================================================
-- TAPX - seed.sql
-- Default game content. Safe to re-run (upserts).
-- Run AFTER schema.sql (and policies.sql if you did not use schema.sql alone).
--
-- This file contains NO user data and NO advertising identifiers.
-- The three ad placements are containers only - the official Adsterra code is
-- pasted into the page by the site owner, never stored in the database.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Upgrades
--    cost(level) = base_cost * growth^level
-- -----------------------------------------------------------------------------

insert into public.upgrades (slug, name, description, icon, base_cost, growth, multiplier, max_level, sort_order, active)
values
  ('tap_power', 'Tap Power',
   'Every tap is worth 15% more coins. Stacks up to 50 levels.',
   'bolt', 100, 1.15, 1.15, 50, 1, true),
  ('combo_boost', 'Combo Boost',
   'Multiplies the reward of every coin gained while your combo is alive by 10% per level.',
   'combo', 250, 1.18, 1.10, 25, 2, true),
  ('critical_tap', 'Critical Tap',
   'Adds a 2% server-rolled chance per level (max 30%) to double the coins of a tap batch.',
   'crit', 1000, 1.25, 1.00, 15, 3, true),
  ('bonus_multiplier', 'Bonus Multiplier',
   'A flat +25% on all coin income per level.',
   'star', 5000, 1.35, 1.25, 20, 4, true)
on conflict (slug) do update
  set name = excluded.name,
      description = excluded.description,
      icon = excluded.icon,
      base_cost = excluded.base_cost,
      growth = excluded.growth,
      multiplier = excluded.multiplier,
      max_level = excluded.max_level,
      sort_order = excluded.sort_order,
      active = excluded.active,
      updated_at = now();

-- -----------------------------------------------------------------------------
-- 2. Milestones
-- -----------------------------------------------------------------------------

insert into public.milestones (name, description, tap_requirement, reward_coins, sort_order, active)
select v.name, v.description, v.tap_requirement, v.reward_coins, v.sort_order, true
from (values
  ('First Contact',    'Your first 100 taps.',     100::bigint,    500::bigint, 1),
  ('Warming Up',       '500 taps in total.',       500,           1500, 2),
  ('Thousand Club',    '1,000 taps in total.',     1000,          3000, 3),
  ('Tap Machine',      '5,000 taps in total.',     5000,          7500, 4),
  ('Ten Thousand',     '10,000 taps in total.',    10000,         15000, 5),
  ('Fifty Thousand',   '50,000 taps in total.',    50000,         50000, 6),
  ('Hundred Thousand', '100,000 taps in total.',  100000,        150000, 7)
) as v(name, description, tap_requirement, reward_coins, sort_order)
where not exists (
  select 1 from public.milestones m where m.name = v.name
);

-- -----------------------------------------------------------------------------
-- 3. Ad placements
--    "location" must match a container that exists in index.html:
--    top | stats | between | inline | bottom
--    Enabling/disabling here only controls whether the VISIBLE container is
--    rendered. It does not and cannot generate or fake any ad activity.
--
--    Every unit loads ONCE per page view. There is no refresh, no timer and no
--    tap-triggered load anywhere in the app.
--
--    The `code` column is deliberately NOT part of this insert. The official
--    Adsterra publisher snippet is pasted by an admin in Admin > Ads (or with
--    the admin_set_ad_code() function), so re-running this file can never
--    overwrite or delete a live ad snippet.
-- -----------------------------------------------------------------------------

insert into public.ad_placements (slug, label, location, description, enabled, sort_order)
values
  ('top', 'Sponsored', 'top',
   'Visible banner directly under the XP card. The official Adsterra code for this placement goes inside the #ad-top container in index.html.',
   false, 1),
  ('stats', 'Sponsored', 'stats',
   'Visible unit directly under the coin/XP chip row, above the XP bar. Official code goes inside #ad-stats. This is NOT the Stats screen.',
   false, 2),
  ('between', 'Sponsored', 'between',
   'Visible unit after the tap area, above the disclaimer. Official code goes inside #ad-between.',
   false, 3),
  ('inline', 'Sponsored', 'inline',
   'Visible in-content unit after the disclaimer. Official code goes inside #ad-inline.',
   false, 4),
  ('bottom', 'Sponsored', 'bottom',
   'Visible unit above the bottom navigation. Official code goes inside #ad-bottom.',
   false, 5)
on conflict (slug) do update
  set label = excluded.label,
      location = excluded.location,
      description = excluded.description,
      sort_order = excluded.sort_order,
      updated_at = now();

-- Script-only ad formats. These have no visible container, so they live in
-- their own table and are never given one of the five slots above.
--
-- on conflict do nothing is deliberate: it preserves a pasted snippet AND the
-- enabled state, so re-running this file can never switch an ad on by accident.
insert into public.ad_scripts (kind, enabled) values
  ('popunder', false),
  ('smartlink', false)
on conflict (kind) do nothing;

-- -----------------------------------------------------------------------------
-- 4. App settings
-- -----------------------------------------------------------------------------

insert into public.app_settings (key, value) values
  ('app_name', '"TAPX"'),
  ('tagline', '"Tap fast. Build combos. Own the leaderboard."'),
  ('maintenance_mode', 'false'),
  ('support_email', '"support@example.com"'),
  ('privacy_url', '"privacy.html"'),
  ('terms_url', '"terms.html"'),
  ('tap_value', '1'),
  ('daily_rewards', '[100, 150, 250, 400, 600, 800, 1200]'),
  ('xp_curve', '"linear_quadratic"'),
  ('reward_offer_enabled', 'false'),
  -- Master ad switch. false = no ad renders anywhere. Toggle it from
  -- Admin > Ads. Ships OFF on purpose.
  ('ads_enabled', 'false')
on conflict (key) do update
  set value = excluded.value, updated_at = now();

-- -----------------------------------------------------------------------------
-- 5. Welcome announcement
-- -----------------------------------------------------------------------------

insert into public.site_announcements (title, message, active)
select 'Welcome to TAPX',
       'Tap the button, build combos, upgrade your tap power and claim your daily reward. Progress is saved to your account.',
       true
where not exists (select 1 from public.site_announcements where title = 'Welcome to TAPX');

-- -----------------------------------------------------------------------------
-- 6. First admin
--    Intentionally NOT automated: granting admin rights must be a deliberate,
--    trusted action.
--
--    Option A (recommended) - run this yourself in the SQL Editor AFTER you
--    have signed up once, replacing the UUID:
--
--      insert into public.admin_users (user_id, role)
--      values ('PASTE-THE-USER-UUID-HERE', 'owner')
--      on conflict (user_id) do update set role = excluded.role;
--
--    To find your UUID, sign in and run this in the SQL editor:
--
--      select id, email from auth.users order by created_at desc limit 5;
--
--    Option B - promote the first account automatically (one time only):
--
--      insert into public.admin_users (user_id, role)
--      select id, 'owner' from auth.users
--      order by created_at asc limit 1
--      on conflict (user_id) do nothing;
--
--    After that, admins can grant or revoke the role from Admin > Users.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- End of seed.sql
-- =============================================================================
