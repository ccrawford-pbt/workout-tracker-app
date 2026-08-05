# Coach Rourke Workout Tracker — developer notes

Single-file, no-build, vanilla-JS workout/weigh-in tracker for one user,
deployed via GitHub Pages from `index.html` at the root of `main`:
https://ccrawford-pbt.github.io/workout-tracker-app/

Used as an iOS home-screen web app (Add to Home Screen from Safari).
No backend, no build step, no dependencies — HTML, CSS, and JS all live in
`index.html`.

## Source of truth — and the deprecated `.jsx` copy

`index.html` in this repo is the **only** maintained version of this app.

An older sibling exists as a Claude.ai React artifact
(`workout-tracker.jsx`, not in this repo): the app was first built there,
then converted to this single portable HTML file because the artifact's
share link couldn't be saved to an iOS home screen correctly. The `.jsx`
artifact is **deprecated and frozen** — it is missing at least the
localStorage-hardening fix (see "Fixed bugs" item 5) and receives no
further updates. Do all work in `index.html`. If the user asks for a
change to the artifact version, tell them it's stale and confirm before
resurrecting it.

## Architecture

No framework. A hand-rolled `el(tag, props, children)` helper mimics just
enough of `React.createElement` to keep the code's shape close to the
original React version. `render()` does a full teardown (`clear(root)`)
and rebuild of the DOM on every state change — no diffing, no partial
updates. Consequences:

- Any test or script that caches a DOM element handle across a `render()`
  call gets a stale reference. Always re-query after a state change.
- Local, uncommitted UI state (like the weight `<input>`s) must live in
  the actual DOM node's `.value` or be threaded through state explicitly —
  a plain JS variable inside a render function does not survive the next
  `render()`.

### State shape

```js
{
  sessions: {
    "<ISO date>": {
      dayNumber: 1 | 2 | 3,
      checks: { "<exercise name>": true },   // only true values stored
      weights: { "<exercise name>": <number> },
      effort: <number 1-10> | null,
      notes: "<string>"
    }
  },
  weighIns: { "<ISO date>": <number in lb> },
  weightDrafts: { "<ISO date>": { "<exercise name>": <number> } },
  updatedAt: <ms epoch of last local mutation>   // drives sync conflict rule
}
```

Persisted to `localStorage` under `"rourke-tracker-v1"`.

### GitHub sync (the repo is the backup store)

The header Save button commits the whole state as `data/state.json` to
`main` via the GitHub Contents API. Auth is a fine-grained PAT (Contents
read & write, scoped to this one repo) pasted once per device in the
History tab's SYNC section and stored under `"rourke-tracker-gh-token"`
in localStorage — never inside the synced file. On launch the app pulls
the remote copy and adopts it only if its `updatedAt` is newer than
local (last-writer-wins; fine for a single user). All sync is
best-effort: any network failure leaves the app fully working offline —
gym connectivity is flaky and must never block logging. Reads go through
the API, not the Pages URL (Pages lags each commit by a deploy cycle).
Caveats: the repo is public, so `data/state.json` is publicly readable
(the SYNC section says so on-screen), and every save is a commit to
`main`, which triggers a harmless Pages rebuild.

### The three non-obvious rules (do not "simplify" these away)

Each exists because a more obvious implementation was wrong in a way that
only showed up under a specific sequence of actions:

1. **A session only counts (shows in History) once ≥1 exercise is
   checked.** Rating effort or typing a note first must NOT create a
   history entry. `updateSession()` deletes the session whenever
   `checkedCount(merged) === 0`, regardless of which field was patched.

2. **Weights survive a session dropping to zero checks.** When a session
   drops to zero checks (accidental un-check, day switch), its weights
   move to `state.weightDrafts[date]` instead of being deleted. The next
   check on that date merges the draft back in and clears the slot.

3. **"Last weight used" searches across day-slots AND drafts.**
   `lastWeightFor()` searches every session for the exercise *name*
   regardless of day-slot ("Seated Leg Curl" is on Day 1 and Day 3 — same
   machine). Two subtleties:
   - The exclusion must be the `(excludeDate, excludeDayNumber)` *pair* —
     the specific session being edited — not the date alone. Same-day
     day-switching is normal, and Day 1's just-logged weight must stay
     visible to Day 3's lookup.
   - The draft-fallback loop must have **no exclusion at all**. A draft
     only exists because its session was already removed, so there is no
     live session to echo back. Excluding drafts by date makes day-switch
     weights permanently invisible — exactly the bug rule 2 exists to
     prevent.

### Day rotation (auto-advance)

Any date with no logged session pre-loads the day after the most
recently logged workout in the 1→2→3→1 rotation, **complete or not** —
D1 logged Monday means D2 is suggested at the next gym visit, whatever
date that lands on. A date whose own session is in progress keeps
showing that session's day. History: this originally advanced only once
every exercise was checked ("incomplete day keeps being suggested"),
also at explicit user request; the user reversed it in Aug 2026 because
a skipped machine kept the same day pinned forever. Don't switch back
without asking.

### Day-pill switching resets checks — intentional, not a bug

One calendar date represents one workout. Switching the day pill resets
that date's checks (weights are preserved via rule 2). A previous session
burned a full debugging cycle "fixing" this with a browsing mode — that
was reverted; the real bug was the lookup-exclusion granularity (rule 3).

## Fixed bugs (don't reintroduce)

1. Warm-up is exercise zero in each day's list (`isWarmup: true`,
   dashed border) — not a separate text field.
2. `lastWeightFor` excluding the whole date (instead of the
   date+dayNumber pair) broke same-day day-switching.
3. The "browsing mode" detour described above — reverted.
4. The draft-fallback loop excluding the current date hid exactly the
   weights it exists to surface.
5. `localStorage` is probed once up front (`storageAvailable`); if the
   probe fails the app shows a warning banner and runs in-memory instead
   of crashing. Added while investigating a blank-screen report on iOS —
   never confirmed as that bug's root cause (only verified against
   Chromium), but proven to degrade gracefully under simulated broken
   storage. If a blank screen is reported again, start here, and pin down
   which context is affected: raw `file://`, the GitHub Pages `https://`
   URL, or the saved home-screen PWA — they are three different execution
   contexts.
6. **"Today" was frozen at page-load time.** As a home-screen app the page
   is suspended and resumed for days without reloading, so the app was
   stuck on whatever date it last launched. `checkDayRollover()` now
   re-checks the calendar on `pageshow`/`focus`/`visibilitychange` and on
   a one-minute interval (midnight rollover while open). It follows the
   calendar forward only if the user was sitting on the old "today" — a
   deliberately selected past date is left alone. Related:
   `todayISO()`/the date strip previously used `toISOString()` (UTC),
   which is tomorrow's date every evening in US timezones; both now use
   local-timezone dates via `toISODate()`.
7. **Header sat under the iPhone status bar** (untappable Save button).
   `black-translucent` status-bar style extends the page under the status
   bar in home-screen mode; `.header` pads past it with
   `env(safe-area-inset-top)`. Don't remove that padding — it looks
   redundant in a desktop browser where the inset is 0.
8. **iOS zoomed the page when focusing inputs.** Safari auto-zooms any
   focused input with font-size < 16px; this UI is deliberately dense
   (13px inputs). Fixed with `maximum-scale=1` in the viewport meta,
   which iOS ignores for user pinch-zoom (since iOS 10) but honors for
   the focus auto-zoom. Don't "clean up" the viewport tag.

## Testing

`test/test-standalone.js` drives `index.html` through real Chromium via
Playwright — 31 assertions covering fresh-load rendering, the zero-check
rule, weight drafts, cross-day-slot lookup, weigh-in math, reload
persistence, day rotation (including multi-day advancement under a fake
clock), a simulated-broken-storage run (localStorage
replaced with a throwing getter before page scripts run), day-rollover
behavior under a fake clock (`page.clock`) — resume-after-days, preserved
past-date selection, the midnight interval check — and GitHub sync
against a fully mocked `api.github.com` (`context.route`): token setup,
the PUT save path, dirty-state tracking, and newer-remote adoption on
launch.

```
node test/test-standalone.js
```

Needs Playwright + Chromium (a global playwright install is picked up
automatically; otherwise `npm install playwright`).

**Known gap:** everything is verified against Chromium only. There is no
WebKit/iOS Safari coverage — iOS-specific reports cannot currently be
reproduced by this suite.

## Product constraints

Single user, total beginner, machine-only training at a commercial gym.
Weigh-ins are the primary progress metric (hence the prominent progress
bar). The UI is dark, dense, and numeric on purpose: it's glanced at and
tapped between sets on a phone — any redesign should keep that constraint.
