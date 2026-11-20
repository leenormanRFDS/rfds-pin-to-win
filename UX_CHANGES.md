# Conference game update

- Optional email registration with required leaderboard name; invalid supplied emails are still rejected.
- Orange glowing departure node, matching map label and orange departure name in the right panel, including on phones.
- A locked pin begins a 6.2-second sequence: confirmation, aircraft route to the player's guess, distance countdown with red/amber/green proximity bands, destination reveal, then animated points.
- The true destination is hidden until the reveal reaches its final stage, including during viewport changes. Input is locked throughout the sequence. Reduced-motion mode uses a brief, stationary reveal.
- No tangible-reward claims appear in the experience.
- Perpetual top-20 cloud leaderboard across all dates (no midnight reset), with event-timezone dates retained for staff exports, server-issued online sessions, server-calculated scores, progress saved per flight and name-safe guest identities.
- Device journal, resumable incomplete games, idempotent retries and offline recovery with explicit pending/recovered labels.
- Staff date selection, daily game export and complete device-backup export.
- Preserved EOI records, API integration and legacy browser leaderboard without attributing undated scores to today.

## Validation

Eight automated backend checks cover optional email, invalid email, accurate scoring, partial/completed distinction, locked-guess immutability, duplicate retries, forged sessions, same-name players, offline date retention, midnight timezone boundaries and database failure responses.

A local PostgreSQL-compatible engine verified that the migration applies twice, the daily function selects the best score per participant, equal names remain separate, ties use distance, prior days remain separate, and anonymous roles cannot read the table or invoke the function.

Browser checks covered desktop, iPad, portrait phones down to 320px, landscape phones, the full six-second reveal, the hidden destination, reduced motion, refresh/resume, a complete three-flight offline game, queued sync and an online server-issued plan. No application JavaScript errors were observed.

Production verification completed on 26 October 2026: the additive scores migration was applied to the existing Supabase project; the deployed configuration and leaderboard endpoints returned successfully; a live game with blank email saved its first flight and the server calculated 1,400 points. The temporary incomplete verification game was removed without appearing on the public board. Database checks verified daily separation, best-score selection and restricted public access. Daily boundaries currently use Australia/Adelaide.

## Perpetual high scores

The main board now ranks completed games across all dates, including existing saved games. Best score per email participant, independent blank-email guest attempts, distance and earliest-attempt tie breaks, and private server access remain in place. Daily archive queries and staff date exports are retained. The offline board also spans all dates and uses a separate all-time cache so a prior daily snapshot cannot appear as an all-time result.

## Admin management

Top-right staff sign-in opens the password-protected dashboard in a separate tab. Staff can download the public high-score table, export all pages of game history and captured entries, remove/restore attempts, and clear completed high scores after typed confirmation. Clearing archives records without deleting them. Active games are preserved; removed games are excluded by the database ranking functions, so another sync cannot put them back. Staff can still retrieve removed records and device backups. API tests cover authentication, same-origin mutation controls, validation, paging and failure responses; browser checks cover sign-in, CSV exports, removal, restore, clear/cancel and sign-out at a landscape iPad viewport.

## v1.3 — engagement, fairness and integrity

- **Mission summary** after flight 3: final score, rank title (Cadet → Chief Pilot), points to the next rank, all-time and today position ("#12 of 230"), per-flight recap, badges (Bullseye, Pinpoint, Clean sweep, Unassisted, Outback ace) and an optional donate/regular-giving call to action.
- **Touch precision:** zoom up to 8× (was 4×) and a magnifier above the finger while dragging. The scoring curve is smooth, with no 100-point cliffs.
- **Fair draws:** every game climbs from an easier to a harder destination across three RFDS sections.
- **Hint:** shades a 300 km area containing the destination, for −150 points.
- **Tasking briefing** before each flight, using the previously unused scenario copy (now including Top End and Central Australian taskings). It is skippable and auto-continues after about 4 seconds.
- **Result screen:** one hero number. The map auto-frames your pin and the destination, and shows where other players pinned, with "closer than X% of N pilots".
- **Leaderboards:** All-time, Today and Teams tabs, plus a read-only big-screen board (`/board.html`) that rotates and highlights new entries.
- **Integrity:** implausible scores (too fast, near-perfect, very high offline) are saved but held for staff review. There is also per-instance rate limiting and guest de-duplication by name and device.
- **Consent:** a leaderboard display name with a blocklist, an optional organisation, a collection notice with a privacy-policy link, and a separate contact opt-in checkbox. Only opted-in players become contact entries. A honeypot field is now in the form.
- **Kiosk:** idle reset, a "Still flying?" prompt mid-game, an in-app leave dialog in place of the native `confirm()`, a 20-minute resume window with Discard, and a smaller header while flying.
- **Offline shell:** a network-first service worker and web app manifest, so the game reloads on dropped Wi-Fi.
- **Fixes and cleanup:**
  - Fixed the undefined `--rfds-orange` variable that could blank tapped buttons on iPad.
  - Map outlines are now stored once and reused (`index.html` went from 127 KB to 74 KB).
  - Removed six unused map assets.
  - Corrected the README (93 destinations) and NT notes (Darwin and Alice Springs bases).
- **Staff:**
  - New review queue with one-click approval.
  - Organisation and review notes in exports.
  - New destination-difficulty statistics.
  - Contact consent shown per entry.
- **Developer:** `npm run dev` runs the real API against an in-memory database. There are now 31 automated tests, and the SQL migration was verified twice-applied against Postgres.
