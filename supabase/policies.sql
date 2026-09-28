-- =============================================================================
-- TAPX - policies.sql
-- Row Level Security policies and table/function grants.
--
-- The same statements are inlined at the end of schema.sql, so running
-- schema.sql alone is enough. This file exists so the security model can be
-- read, reviewed and re-applied on its own.
--
-- Everything here is idempotent (DROP POLICY IF EXISTS / CREATE OR REPLACE).
--
-- SECURITY MODEL
--   anon           -> public catalogue only (upgrades, milestones, placements,
--                     app settings, active announcements)
--   authenticated  -> own rows only, cosmetic columns only
--   privileged     -> SECURITY DEFINER RPCs that re-validate every value
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Make sure RLS is switched on everywhere
-- -----------------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.game_state          enable row level security;
alter table public.upgrades            enable row level security;
alter table public.user_upgrades       enable row level security;
alter table public.milestones          enable row level security;
alter table public.user_milestones     enable row level security;
alter table public.daily_rewards       enable row level security;
alter table public.ad_events           enable row level security;
alter table public.admin_users         enable row level security;
alter table public.app_settings        enable row level security;
alter table public.ad_placements       enable row level security;
alter table public.site_announcements  enable row level security;

-- -----------------------------------------------------------------------------
-- 2. profiles - a user may read and rename their own profile, nothing else.
--    coins / total_taps / level / experience / highest_combo are additionally
--    protected by the guard_profile_write() trigger AND by column grants.
-- -----------------------------------------------------------------------------

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- -----------------------------------------------------------------------------
-- 3. game_state - preferences only (sound / vibration).
-- -----------------------------------------------------------------------------

drop policy if exists "game_state_select_own" on public.game_state;
create policy "game_state_select_own" on public.game_state
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "game_state_update_own" on public.game_state;
create policy "game_state_update_own" on public.game_state
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 4. Public catalogue
-- -----------------------------------------------------------------------------

drop policy if exists "upgrades_public_read" on public.upgrades;
create policy "upgrades_public_read" on public.upgrades
  for select to anon, authenticated using (active or public.is_admin());

drop policy if exists "upgrades_admin_write" on public.upgrades;
create policy "upgrades_admin_write" on public.upgrades
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "milestones_public_read" on public.milestones;
create policy "milestones_public_read" on public.milestones
  for select to anon, authenticated using (active or public.is_admin());

drop policy if exists "milestones_admin_write" on public.milestones;
create policy "milestones_admin_write" on public.milestones
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "placements_public_read" on public.ad_placements;
create policy "placements_public_read" on public.ad_placements
  for select to anon, authenticated using (true);

drop policy if exists "placements_admin_write" on public.ad_placements;
create policy "placements_admin_write" on public.ad_placements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ad_scripts. Reads are admin-only: the game never queries this table directly,
-- it receives the enabled snippets through get_public_config(), which is
-- SECURITY DEFINER. So a signed-in non-admin cannot list the table or read a
-- disabled row. Writes go through admin_set_ad_script(), which additionally
-- calls require_admin() and re-validates the snippet.
drop policy if exists "scripts_admin_read" on public.ad_scripts;
create policy "scripts_admin_read" on public.ad_scripts
  for select to authenticated using (public.is_admin());

drop policy if exists "scripts_admin_write" on public.ad_scripts;
create policy "scripts_admin_write" on public.ad_scripts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "settings_public_read" on public.app_settings;
create policy "settings_public_read" on public.app_settings
  for select to anon, authenticated using (true);

drop policy if exists "settings_admin_write" on public.app_settings;
create policy "settings_admin_write" on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "announcements_public_read" on public.site_announcements;
create policy "announcements_public_read" on public.site_announcements
  for select to anon, authenticated using (active or public.is_admin());

drop policy if exists "announcements_admin_write" on public.site_announcements;
create policy "announcements_admin_write" on public.site_announcements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- -----------------------------------------------------------------------------
-- 5. Owned progression rows - READ ONLY for clients.
--    Writes happen exclusively inside the SECURITY DEFINER RPCs, so there is
--    intentionally no insert/update/delete policy for these tables.
-- -----------------------------------------------------------------------------

drop policy if exists "user_upgrades_select_own" on public.user_upgrades;
create policy "user_upgrades_select_own" on public.user_upgrades
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "user_milestones_select_own" on public.user_milestones;
create policy "user_milestones_select_own" on public.user_milestones
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "daily_rewards_select_own" on public.daily_rewards;
create policy "daily_rewards_select_own" on public.daily_rewards
  for select to authenticated using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 6. ad_events
--   Insert only for the current user, no update, no delete.
--   The guard_ad_event() trigger rejects unknown/disabled placements, restricts
--   event_type to a fixed list and rate limits to one event per placement per
--   minute. This table records genuine application events - it never creates
--   impressions, and it is never sent to the advertising network.
-- -----------------------------------------------------------------------------

drop policy if exists "ad_events_insert_own" on public.ad_events;
create policy "ad_events_insert_own" on public.ad_events
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "ad_events_select_own" on public.ad_events;
create policy "ad_events_select_own" on public.ad_events
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- -----------------------------------------------------------------------------
-- 7. admin_users
--   A user can see whether THEY are an admin. Membership is never writable
--   from the client - it is granted through the admin_set_admin() RPC or by a
--   trusted operator running SQL directly.
-- -----------------------------------------------------------------------------

drop policy if exists "admin_users_select_own" on public.admin_users;
create policy "admin_users_select_own" on public.admin_users
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- -----------------------------------------------------------------------------
-- 8. Column level privileges
--    Even with RLS, do not let the client name a column it must not change.
-- -----------------------------------------------------------------------------

revoke insert, delete on table public.profiles   from authenticated;
revoke update on table public.profiles           from authenticated;
grant  update (username, display_name, avatar_url) on public.profiles to authenticated;

revoke insert, delete on table public.game_state from authenticated;
revoke update on table public.game_state         from authenticated;
grant  update (sound_enabled, vibration_enabled) on public.game_state to authenticated;

revoke all on table public.user_upgrades   from anon, authenticated;
grant  select on table public.user_upgrades   to authenticated;

revoke all on table public.user_milestones  from anon, authenticated;
grant  select on table public.user_milestones  to authenticated;

revoke all on table public.daily_rewards   from anon;
grant  select on table public.daily_rewards   to authenticated;

revoke all on table public.ad_events        from anon;
revoke update, delete on table public.ad_events from authenticated;
grant insert, select on table public.ad_events to authenticated;

revoke all on table public.admin_users      from anon;
revoke insert, update, delete on table public.admin_users from authenticated;
grant select on table public.admin_users     to authenticated;

revoke insert, update, delete on table public.app_settings from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 9. Function privileges
--    No function is executable by PUBLIC by default. Helper/trigger functions
--    stay private; the client receives only the RPCs listed below.
-- -----------------------------------------------------------------------------

revoke execute on function public.set_updated_at()            from public;
revoke execute on function public.xp_to_next(integer)         from public;
revoke execute on function public.game_limits()               from public;
revoke execute on function public.handle_new_user()           from public;
revoke execute on function public.guard_profile_write()       from public;
revoke execute on function public.guard_game_state_write()    from public;
revoke execute on function public.guard_ad_event()            from public;
revoke execute on function public.require_admin()             from public;
revoke execute on function public.ensure_user_state(uuid)     from public;
revoke execute on function public.is_admin()                  from public;

-- is_admin() must be executable by anon as well: the public catalogue policies
-- evaluate it, and an anonymous request would otherwise fail with
-- "permission denied for function is_admin" instead of returning false.
grant execute on function public.is_admin()              to anon, authenticated;
grant execute on function public.ensure_user_state(uuid) to authenticated;

-- Gameplay
grant execute on function public.process_tap(integer, integer, integer) to authenticated;
grant execute on function public.purchase_upgrade(bigint)   to authenticated;
grant execute on function public.upgrade_cost(bigint)       to authenticated;
grant execute on function public.claim_daily_reward()       to authenticated;
grant execute on function public.claim_milestone(bigint)    to authenticated;
grant execute on function public.record_ad_event(text, text) to authenticated;

-- Reads
grant execute on function public.get_player_state()         to authenticated;
grant execute on function public.get_user_stats()           to authenticated;
grant execute on function public.get_milestone_status()      to authenticated;
grant execute on function public.get_public_config()        to anon, authenticated;

-- Administration (each one calls require_admin() internally)
grant execute on function public.admin_overview()                                          to authenticated;
grant execute on function public.admin_search_users(text, integer, integer)                to authenticated;
grant execute on function public.admin_list_settings()                                     to authenticated;
grant execute on function public.admin_set_setting(text, jsonb)                            to authenticated;
grant execute on function public.admin_save_placement(bigint, text, text, text, text, boolean, integer) to authenticated;
grant execute on function public.admin_ensure_placements()            to authenticated;
grant execute on function public.admin_set_ad_code(text, text)      to authenticated;
grant execute on function public.admin_set_ad_script(text, text, boolean) to authenticated;
grant execute on function public.admin_ensure_ad_scripts()         to authenticated;
grant execute on function public.admin_delete_placement(bigint)     to authenticated;
grant execute on function public.admin_save_upgrade(bigint, text, text, text, text, bigint, numeric, numeric, integer, integer, boolean) to authenticated;
grant execute on function public.admin_delete_upgrade(bigint)                              to authenticated;
grant execute on function public.admin_save_milestone(bigint, text, text, bigint, bigint, integer, boolean) to authenticated;
grant execute on function public.admin_delete_milestone(bigint)                            to authenticated;
grant execute on function public.admin_save_announcement(bigint, text, text, boolean)      to authenticated;
grant execute on function public.admin_delete_announcement(bigint)                          to authenticated;
grant execute on function public.admin_adjust_coins(uuid, bigint, text)                     to authenticated;
grant execute on function public.admin_set_admin(uuid, text, boolean)                       to authenticated;

-- -----------------------------------------------------------------------------
-- 10. Verification queries (run these after setup)
-- -----------------------------------------------------------------------------
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
--
-- Expected: every table shows rowsecurity = true.
--
-- SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public'
--   ORDER BY tablename, policyname;
--
-- As an anonymous key you should see zero rows from:
--   profiles, game_state, user_upgrades, user_milestones,
--   daily_rewards, ad_events, admin_users.
--
-- =============================================================================
-- End of policies.sql
-- =============================================================================
