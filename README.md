# RFDS Pin to Win — conference edition (v1.3)

Three RFDS taskings per game, drawn from 93 remote destinations. Each game climbs in difficulty (warm-up → standard → remote) across three different RFDS sections. Players drop a pin, watch a six-second flight and distance reveal, then finish on a mission summary with a rank title, badges and their leaderboard position.

Static HTML/CSS/JavaScript with Vercel Node.js API functions and Supabase.

- Game: `/`
- Big-screen leaderboard for a TV or projector: `/board.html`
- Staff dashboard: `/admin.html`

## Deploy checklist for v1.3

1. **Run `supabase/pin_to_win_v1_3.sql` once** in the Supabase SQL Editor. It is additive and safe to run again. It adds the review queue, organisations, the rank and team-board functions, a crowd index and contact-consent columns. Without it, games still save, but ranks show as "on the leaderboard", the Teams tab reports setup pending, and the admin dashboard's game list and contact list fail.
2. **Fill in `public/config.js`**: the RFDS SA/NT privacy policy URL (strongly recommended, because the registration collection notice links to it), an optional donate or regular-giving URL for the summary screen, and an optional GTM container ID.
3. Deploy to Vercel as before. Framework preset **Other**, no build command, no output directory.
4. On the conference iPad, load the game once while online so the offline shell is cached. "Add to Home Screen" gives a full-screen kiosk.
5. Physically test pin placement and the touch magnifier on the actual iPad before the event.

Environment variables (unchanged):

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` — private server key, never a browser key
- `PIN_TO_WIN_ADMIN_PASSWORD` — private staff password
- `PIN_TO_WIN_ADMIN_SESSION_SECRET` — stable private signing secret
- `PIN_TO_WIN_EVENT_ID` — default `rfds-conference`. Keep it stable to keep the same perpetual leaderboard.
- `PIN_TO_WIN_TIMEZONE` — default `Australia/Adelaide`.
- `PIN_TO_WIN_RATE_LIMIT` — set to `off` only for local testing.

## Database setup (new project)

Run, in order: `pin_to_win_eois.sql`, `pin_to_win_games.sql`, `pin_to_win_v1_3.sql`. Existing installations that were set up before moderation also need `pin_to_win_moderation.sql` (harmless to re-run). Browser and public roles cannot read or write any table or call any function. The public leaderboard returns names, organisations and scores only.

## Scoring and fairness

- **Per flight:** base `1000 − km` (minimum 0) plus a precision bonus of `400 × e^(−km/50)`. That gives about 327 at 10 km, 243 at 25 km, 147 at 50 km and 54 at 100 km. There are no cliff edges. Maximum 1,400 per flight and 4,200 per game. Scores saved before v1.3 used stepped bonuses and remain on the board unchanged. Old and new scoring differ by up to about 130 points per flight (largest just past the old 5, 10 and 25 km cut-offs), so for a clean comparison, archive the board with **Clear leaderboard** before the next event.
- **Hint:** shades a 300 km area that contains the destination (offset, never centred on it) for −150 points.
- **Draw:** every game is one destination rated 2–3, one rated 3–4 and one rated 4–5, each from a different RFDS section. Use the admin **Destination difficulty** panel to check real player error and adjust `difficulty` in `data/destinations.js`.
- **Shared rules:** scoring, the draw, ranks, badges and the name filter live in `data/rules.js`, which both the browser and the server load. The server always recalculates scores from the submitted pins.

## Leaderboard integrity

Scores that look implausible are saved, kept off the public board, and appear in the admin **review queue**. Staff approve them with one click. A game is held when:

- pins arrive faster than 3 seconds per flight (the reveal alone takes about 6 seconds),
- all three pins total under 6 km of error, or
- a game played offline scores 3,800 or more (offline games have no server timing).

The plan is still sent to the browser and destination coordinates ship in `data/destinations.js`, because offline play needs them. A technical person could still construct a believable score that avoids every rule above. Closing that fully means dropping offline play and revealing destinations one at a time from the server. The review queue, rate limiting (a per-instance speed bump, generous enough for shared conference Wi-Fi) and staff moderation are the practical defence.

Player identity: an email keeps one identity across devices. Guests without an email are grouped by name on the same device, so one person replaying at a kiosk can't fill the board. The same name on different devices stays separate.

## Players and privacy

- The leaderboard name is a display name or call sign, checked against a starting blocklist in `data/rules.js`. Extend it for your audience; it uses whole-word matching to avoid blocking real names and places such as Scunthorpe or Cockburn.
- Email and organisation are optional. A collection notice explains what is shown publicly.
- **Contact requests:** only players who tick "contact me" (which requires an email) are recorded in `pin_to_win_eois`, with `contact_opt_in = true` and a `consent_version`. Entries collected before v1.3 show "Not recorded" in the dashboard; check with your privacy team before contacting them.
- Analytics events go to `dataLayer` (`ptw_start`, `ptw_flight_complete`, `ptw_hint_used`, `ptw_game_complete`, `ptw_board_view`, `ptw_contact_opt_in`, `ptw_resume`). Names and emails are never sent.

## Kiosk behaviour

- Result, summary, leaderboard and registration screens return to the start after 90 seconds idle. Mid-flight, a "Still flying?" prompt appears after 2 minutes and counts down 20 seconds. Progress is always saved first. Timings are in `public/config.js`.
- Unfinished games are offered for 20 minutes on the start screen, with a Discard option, so the next player isn't shown an old name indefinitely.
- Tapping the logo mid-game asks to confirm in an in-app dialog.

## Persistence and recovery

- The server issues an online session and destinations, signs a session token and recalculates all scores from submitted pins.
- Every locked pin is journalled before its animation, and online progress is saved after each flight. Only three-flight completions rank.
- If a game begins offline it keeps its local plan and original start time, and is recalculated and marked "recovered offline" when the connection returns (up to 14 days, with 5 minutes of clock-skew tolerance).
- Unique game IDs and immutable locked pins prevent retries from duplicating scores.
- The service worker (`/sw.js`) is network-first, so a new deploy is picked up on the next load. It falls back to the cached shell only when offline, and never caches `/api` or admin pages.

Local keys: `rfds_pin_to_win_rounds_v2` (games and queue), `rfds_pin_to_win_config_v2`, `rfds_pin_to_win_device_v1` (random device ID), `rfds_pin_to_win_board_*_v1` (board caches), `rfds_pin_to_win_eois` (contact backup), `rfds_demo_board` (legacy, preserved).

Don't clear site data on the conference iPad while unsynced records remain. Export the device backup from the dashboard first.

## Staff dashboard

Sign in with `PIN_TO_WIN_ADMIN_PASSWORD` (8-hour HttpOnly, Secure, SameSite=Strict cookie). From the dashboard you can:

- approve held scores,
- remove or restore attempts,
- clear the board (archive only, with typed confirmation),
- export the leaderboard, game history (with organisation and review notes) and contact requests,
- load per-destination difficulty statistics,
- open the big-screen board.

## Local checks

- `npm test` — 31 tests covering scoring, the draw, the name filter, integrity flags, ranks, teams, crowd data, consent, identity, idempotency, timezones, moderation and failure handling. No credentials are needed.
- `npm run dev` — local preview at http://localhost:3000 running the **real API handlers** against an in-memory database (admin password `dev`). Nothing is saved between runs.
- `npm start` — static-only preview, with the API disabled.

NT destination references are documented in `NT_LOCATIONS.md`. Destinations can carry an optional `fact` string in `data/destinations.js`, shown on the result screen. None are filled in yet: add only lines that RFDS has verified.
