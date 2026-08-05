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
  weightDrafts: { "<ISO date>": { "<exercise name>": <number> } }
}
```

Persisted to `localStorage` under `"rourke-tracker-v1"`.

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

### Auto-advance

`nextDayNumber()` only advances the 1→2→3→1 rotation once the most
recently touched session is fully checked. An incomplete day keeps being
suggested across app opens — even across calendar days. This is an
explicit user request; don't change it to "advance once per day" without
asking.

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

## Testing

`test/test-standalone.js` drives `index.html` through real Chromium via
Playwright — 25 assertions covering fresh-load rendering, the zero-check
rule, weight drafts, cross-day-slot lookup, weigh-in math, reload
persistence, auto-advance, a simulated-broken-storage run (localStorage
replaced with a throwing getter before page scripts run), and day-rollover
behavior under a fake clock (`page.clock`) — resume-after-days, preserved
past-date selection, and the midnight interval check.

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
