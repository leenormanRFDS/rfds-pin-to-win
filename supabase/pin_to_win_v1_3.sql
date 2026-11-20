-- Pin to Win v1.3: review queue, organisations/teams, rank lookup, crowd index and contact consent.
-- Run once in the Supabase SQL Editor AFTER pin_to_win_eois.sql and pin_to_win_games.sql.
-- Additive only: no scores, games or entries are deleted or altered. Safe to run again.
begin;

-- Games: optional organisation (team board) and the reason a game is held for staff review.
alter table public.pin_to_win_games add column if not exists organisation text;
alter table public.pin_to_win_games add column if not exists review_reason text;
create index if not exists pin_to_win_games_missions on public.pin_to_win_games using gin (mission_ids);

-- Entries: only players who tick the contact box are recorded from v1.3 onwards.
-- Existing rows keep contact_opt_in = false, because their consent was not recorded.
alter table public.pin_to_win_eois add column if not exists organisation text;
alter table public.pin_to_win_eois add column if not exists contact_opt_in boolean not null default false;
alter table public.pin_to_win_eois add column if not exists consent_version text;

-- Where one game would rank among every player's best visible score (all-time, or one conference day).
create or replace function public.pin_to_win_rank(event_key text, game_key uuid, day_key date default null)
returns table(rank bigint, total bigint, best_score integer)
language sql stable security invoker set search_path = '' as $$
  with best as (
    select distinct on (g.player_id) g.player_id, g.score, g.total_distance
    from public.pin_to_win_games g
    where g.event_id = event_key and g.completed and g.hidden_at is null
      and (day_key is null or g.event_day = day_key)
    order by g.player_id, g.score desc, g.total_distance asc, g.started_at asc, g.id
  ), me as (
    select g.player_id, g.score, g.total_distance
    from public.pin_to_win_games g
    where g.id = game_key and g.event_id = event_key and g.completed
  )
  select
    1 + (select count(*) from best b where b.player_id <> me.player_id
         and (b.score > me.score or (b.score = me.score and b.total_distance < me.total_distance))) as rank,
    1 + (select count(*) from best b where b.player_id <> me.player_id) as total,
    (select b.score from best b where b.player_id = me.player_id) as best_score
  from me;
$$;
revoke all on function public.pin_to_win_rank(text, uuid, date) from public, anon, authenticated;
grant execute on function public.pin_to_win_rank(text, uuid, date) to service_role;

-- Team board: average of each member's best score. Teams need at least two players.
create or replace function public.pin_to_win_team_board(event_key text, day_key date default null)
returns table(team text, players bigint, average_score integer, top_score integer)
language sql stable security invoker set search_path = '' as $$
  with best as (
    select distinct on (g.player_id) g.player_id, g.organisation, g.score, g.total_distance
    from public.pin_to_win_games g
    where g.event_id = event_key and g.completed and g.hidden_at is null
      and nullif(trim(g.organisation), '') is not null
      and (day_key is null or g.event_day = day_key)
    order by g.player_id, g.score desc, g.total_distance asc, g.started_at asc, g.id
  )
  -- Shown under the spelling the team's top scorer entered.
  select (array_agg(trim(b.organisation) order by b.score desc, b.total_distance asc))[1] as team, count(*) as players,
         round(avg(b.score))::integer as average_score, max(b.score) as top_score
  from best b
  group by lower(trim(b.organisation))
  having count(*) >= 2
  order by average_score desc, players desc, team
  limit 20;
$$;
revoke all on function public.pin_to_win_team_board(text, date) from public, anon, authenticated;
grant execute on function public.pin_to_win_team_board(text, date) to service_role;

commit;
notify pgrst, 'reload schema';
