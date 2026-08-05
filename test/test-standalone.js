/*
 * End-to-end tests for index.html (the Coach Rourke workout tracker).
 *
 * Drives the real file through a real Chromium instance via Playwright.
 * Run with:
 *
 *   node test/test-standalone.js
 *
 * Requires Playwright + a Chromium install. Works out of the box in an
 * environment with a global playwright install (falls back to `npm root -g`
 * resolution); otherwise `npm install playwright` first.
 *
 * NOTE: these tests run against Chromium only. iOS Safari / WebKit behavior
 * is NOT covered — if an iOS-specific bug is reported, this suite cannot
 * reproduce it.
 */

"use strict";

const path = require("path");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (e) {
    const globalRoot = require("child_process")
      .execSync("npm root -g")
      .toString()
      .trim();
    return require(path.join(globalRoot, "playwright"));
  }
}

const { chromium } = loadPlaywright();

const PAGE_URL = "file://" + path.resolve(__dirname, "..", "index.html");
const STORAGE_KEY = "rourke-tracker-v1";

let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    console.log("  ✓ " + name);
  } else {
    failed++;
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}

// Local-timezone date, matching the app's own todayISO() — toISOString()
// would be UTC and disagree with the app every evening in western timezones.
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function readStorage(page) {
  return page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) || "null"),
    STORAGE_KEY
  );
}

// The app does a full DOM teardown + rebuild on every state change, so
// element handles go stale constantly. Every helper here re-queries from
// scratch; never cache a handle across an interaction.

async function clickCheckbox(page, exerciseName, currentlyChecked) {
  const label = currentlyChecked
    ? `Mark ${exerciseName} as not done`
    : `Mark ${exerciseName} as done`;
  await page.click(`button[aria-label="${label}"]`);
}

async function setWeight(page, exerciseName, value) {
  const sel = `input[aria-label="Weight for ${exerciseName}"]`;
  await page.fill(sel, value);
  await page.$eval(sel, (el) => el.blur()); // blur commits the value
}

async function getWeightValue(page, exerciseName) {
  return page.$eval(
    `input[aria-label="Weight for ${exerciseName}"]`,
    (el) => el.value
  );
}

async function lastLabelFor(page, exerciseName) {
  return page.evaluate((name) => {
    const input = document.querySelector(
      `input[aria-label="Weight for ${name}"]`
    );
    if (!input) return null;
    const row = input.closest(".weight-row");
    const last = row && row.querySelector(".weight-last");
    return last ? last.textContent : null;
  }, exerciseName);
}

async function goTab(page, label) {
  await page.click(`.tabbar-btn:has-text("${label}")`);
}

async function activeDayPill(page) {
  return page.$eval(".day-pill-active .day-pill-num", (el) => el.textContent);
}

async function progressBadge(page) {
  return page.$eval(".progress-badge", (el) => el.textContent);
}

async function main() {
  const browser = await chromium.launch();
  const today = isoDaysAgo(0);

  // ---------- Main suite: fresh context, working localStorage ----------
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    failed++;
    console.log("  ✗ page JS error: " + err.message);
  });
  await page.goto(PAGE_URL);

  console.log("\nFresh load");
  assert(
    "1. header renders with title",
    (await page.$eval(".title", (el) => el.textContent)) === "Weeks 1–4"
  );
  assert(
    "2. Day 1 suggested with 7 exercises, warmup dashed, badge 0/7",
    (await activeDayPill(page)) === "D1" &&
      (await page.$$eval(".exercise-row", (els) => els.length)) === 7 &&
      (await page.$(".exercise-row-warmup")) !== null &&
      (await progressBadge(page)) === "0/7"
  );

  console.log("\nZero-check session rule");
  // Rate effort and type a note with nothing checked — must NOT create a session.
  await page.click('button[aria-label="Set effort to 7"]');
  await page.fill(".notes-input", "should not create a session");
  await page.$eval(".notes-input", (el) => el.blur());
  let stored = await readStorage(page);
  await goTab(page, "History");
  assert(
    "3. effort + notes alone create no session (storage empty, History empty)",
    (!stored || Object.keys(stored.sessions || {}).length === 0) &&
      (await page.$eval(".empty-state", (el) => el.textContent)).includes(
        "No sessions logged yet"
      )
  );
  await goTab(page, "Today");

  console.log("\nSession creation + weights");
  await clickCheckbox(page, "Leg Press", false);
  await goTab(page, "History");
  assert(
    "4. checking one box logs the session (1/7 done in History)",
    (await page.$eval(".session-completion", (el) => el.textContent)) ===
      "1/7 done"
  );
  await goTab(page, "Today");

  await page.click('button[aria-label="Set effort to 7"]');
  assert(
    "5. effort persists once the session exists",
    (await page.$eval(".effort-readout", (el) => el.textContent)) === "7/10"
  );

  await setWeight(page, "Leg Press", "135");
  stored = await readStorage(page);
  assert(
    "6. committed weight lands in session.weights",
    stored.sessions[today] &&
      stored.sessions[today].weights["Leg Press"] === 135
  );

  console.log("\nWeights survive a zero-check drop (weightDrafts)");
  await clickCheckbox(page, "Leg Press", true); // uncheck → session must vanish
  stored = await readStorage(page);
  assert(
    "7. unchecking to zero removes session but parks weight in weightDrafts",
    Object.keys(stored.sessions).length === 0 &&
      stored.weightDrafts[today] &&
      stored.weightDrafts[today]["Leg Press"] === 135
  );
  assert(
    "8. drafted weight still shown in the input after the drop",
    (await getWeightValue(page, "Leg Press")) === "135"
  );

  await clickCheckbox(page, "Leg Press", false); // recheck → draft merges back
  stored = await readStorage(page);
  assert(
    "9. rechecking restores drafted weight into the session and clears drafts",
    stored.sessions[today].weights["Leg Press"] === 135 &&
      !stored.weightDrafts[today]
  );

  console.log("\nCross-day-slot weight lookup");
  await setWeight(page, "Seated Leg Curl", "70");
  // Switch Day 1 → Day 3 on the same date. Checks reset (intentional: one
  // date = one workout), weights move to drafts, and Seated Leg Curl on
  // Day 3 must still surface 70 as "last".
  await page.click('.day-pill:has-text("D3")');
  assert(
    "10. day-pill switch resets checks (D3 active, badge 0/7)",
    (await activeDayPill(page)) === "D3" &&
      (await progressBadge(page)) === "0/7"
  );
  assert(
    "11. Day 1's Seated Leg Curl weight visible as 'last' on Day 3",
    (await lastLabelFor(page, "Seated Leg Curl")) === "last: 70 lb"
  );

  await clickCheckbox(page, "Leg Press", false);
  stored = await readStorage(page);
  assert(
    "12. first check on Day 3 merges ALL drafted weights back in",
    stored.sessions[today].dayNumber === 3 &&
      stored.sessions[today].weights["Leg Press"] === 135 &&
      stored.sessions[today].weights["Seated Leg Curl"] === 70 &&
      !stored.weightDrafts[today]
  );

  console.log("\nWeigh-ins");
  await goTab(page, "Weight");
  await page.fill(".entry-date", isoDaysAgo(7));
  await page.fill(".entry-weight", "250");
  await page.click(".entry-submit");
  await page.fill(".entry-date", today);
  await page.fill(".entry-weight", "247.5");
  await page.click(".entry-submit");
  {
    const stats = await page.$$eval(".stat-value", (els) =>
      els.map((e) => e.textContent)
    );
    const delta = await page.$eval(".weighin-delta", (el) => ({
      text: el.textContent,
      down: el.className.includes("weighin-delta-down"),
    }));
    const fillPct = await page.$eval(".progress-fill", (el) =>
      parseFloat(el.style.width)
    );
    assert(
      "13. weigh-in math: current 247.5, lost 2.5, to-goal 57.5, delta -2.5↓, bar ~4.17%",
      stats[0] === "247.5" &&
        stats[1] === "2.5" &&
        stats[2] === "57.5" &&
        delta.text === "-2.5" &&
        delta.down &&
        Math.abs(fillPct - (2.5 / 60) * 100) < 0.01,
      JSON.stringify({ stats, delta, fillPct })
    );
  }
  {
    // Delete the older (250) entry — newest-first list, so it's row index 1.
    const deletes = await page.$$(".weighin-delete");
    await deletes[1].click();
    const rows = await page.$$eval(".weighin-weight", (els) =>
      els.map((e) => e.textContent)
    );
    assert(
      "14. deleting a weigh-in removes only that row",
      rows.length === 1 && rows[0] === "247.5 lb"
    );
  }

  console.log("\nPersistence across reload");
  await page.reload();
  assert(
    "15. session state survives reload (D3 active, Leg Press checked, weights intact)",
    (await activeDayPill(page)) === "D3" &&
      (await page.$('button[aria-label="Mark Leg Press as not done"]')) !==
        null &&
      (await getWeightValue(page, "Leg Press")) === "135" &&
      (await getWeightValue(page, "Seated Leg Curl")) === "70"
  );
  await goTab(page, "Weight");
  assert(
    "16. weigh-ins survive reload",
    (await page.$$eval(".stat-value", (els) => els[0].textContent)) === "247.5"
  );
  await goTab(page, "Today");

  console.log("\nDay rotation (advances from the last logged workout)");
  // Today's Day 3 session has only Leg Press checked — incomplete, but the
  // rotation still moves on: a fresh date suggests the NEXT day (3 wraps
  // to 1). Completion is not required to advance.
  await page.$$eval(".date-chip", (els) => els[5].click()); // yesterday
  assert(
    "17. a fresh date suggests the day after the last logged one (D3→D1, incomplete)",
    (await activeDayPill(page)) === "D1"
  );
  await page.$$eval(".date-chip", (els) => els[6].click()); // back to today
  assert(
    "18. a date with a session in progress keeps showing that session's day",
    (await activeDayPill(page)) === "D3" && (await progressBadge(page)) === "1/7"
  );

  // Completion styling still works.
  const day3Rest = [
    "Warm-Up",
    "Chest Press Machine",
    "Lat Pulldown",
    "Seated Row Machine",
    "Seated Leg Curl",
    "Incline Treadmill Walk",
  ];
  for (const name of day3Rest) {
    await clickCheckbox(page, name, false);
  }
  assert(
    "19. all boxes checked shows 7/7 with done styling",
    (await progressBadge(page)) === "7/7" &&
      (await page.$(".progress-badge-done")) !== null
  );

  await context.close();

  // ---------- Broken-storage suite: localStorage access throws ----------
  console.log("\nBroken storage (simulated restrictive context)");
  const brokenContext = await browser.newContext();
  const brokenPage = await brokenContext.newPage();
  let brokenPageError = null;
  brokenPage.on("pageerror", (err) => {
    brokenPageError = err.message;
  });
  // Equivalent of Puppeteer's evaluateOnNewDocument: runs before the page's
  // own script, replacing localStorage with a getter that throws — the
  // failure mode some restrictive WebKit contexts exhibit.
  await brokenPage.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await brokenPage.goto(PAGE_URL);
  assert(
    "20. app still renders with storage throwing (no crash, warning banner shown)",
    brokenPageError === null &&
      (await brokenPage.$eval(".title", (el) => el.textContent)) ===
        "Weeks 1–4" &&
      (await brokenPage.$(".storage-warning")) !== null
  );
  await brokenPage.click('button[aria-label="Mark Warm-Up as done"]');
  assert(
    "21. app remains interactive in-memory (checkbox works, badge 1/7)",
    brokenPageError === null && (await progressBadge(brokenPage)) === "1/7"
  );
  await brokenContext.close();

  // ---------- Day-rollover suite: fake clock, no reloads ----------
  // As an iOS home-screen app the page gets suspended and resumed for days
  // without reloading. "Today" must follow the calendar on wake (pageshow /
  // focus / visibilitychange) and on the minute-interval midnight check.
  console.log("\nDay rollover without reload");
  const clockContext = await browser.newContext();
  const clockPage = await clockContext.newPage();
  await clockPage.clock.install({ time: new Date("2026-03-10T12:00:00") });
  await clockPage.goto(PAGE_URL);

  const activeChipNum = () =>
    clockPage.$eval(".date-chip-active .date-chip-num", (el) => el.textContent);
  const chipNums = () =>
    clockPage.$$eval(".date-chip .date-chip-num", (els) =>
      els.map((e) => e.textContent)
    );

  assert("22. app opens on the (faked) current day", (await activeChipNum()) === "10");

  // Suspend for two days, then resume — the wake events must move "today".
  await clockPage.clock.setFixedTime(new Date("2026-03-12T12:00:00"));
  await clockPage.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  assert(
    "23. resuming after two days advances today and the date strip",
    (await activeChipNum()) === "12" && (await chipNums())[6] === "12"
  );

  // A deliberately selected past date must NOT be yanked forward on wake —
  // but the strip itself still shifts.
  await clockPage.$$eval(".date-chip", (els) => els[5].click()); // Mar 11
  await clockPage.clock.setFixedTime(new Date("2026-03-13T12:00:00"));
  await clockPage.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  assert(
    "24. wake keeps a deliberately selected past date, strip still shifts",
    (await activeChipNum()) === "11" && (await chipNums())[6] === "13"
  );

  // Midnight rollover while the app is open, no wake event at all: the
  // minute-interval check must catch it. Re-select the current today first.
  await clockPage.$$eval(".date-chip", (els) => els[6].click()); // Mar 13
  await clockPage.clock.setSystemTime(new Date("2026-03-13T23:59:30"));
  await clockPage.clock.runFor("02:00"); // cross midnight, fire the interval
  assert(
    "25. minute interval catches a midnight rollover while open",
    (await activeChipNum()) === "14" && (await chipNums())[6] === "14"
  );
  await clockContext.close();

  // ---------- GitHub sync suite: api.github.com fully mocked ----------
  console.log("\nGitHub sync (mocked API)");
  const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, accept",
    "access-control-allow-methods": "GET, PUT, OPTIONS",
  };
  const API_FILE_URL =
    "https://api.github.com/repos/ccrawford-pbt/workout-tracker-app/contents/data/state.json";

  // Save path: no remote file yet (GET → 404), PUT captured and inspected.
  const syncContext = await browser.newContext();
  let putRequest = null;
  await syncContext.route("https://api.github.com/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: CORS_HEADERS });
    }
    if (req.method() === "GET") {
      return route.fulfill({
        status: 404,
        headers: CORS_HEADERS,
        contentType: "application/json",
        body: '{"message":"Not Found"}',
      });
    }
    if (req.method() === "PUT") {
      putRequest = {
        url: req.url(),
        auth: req.headers()["authorization"],
        body: JSON.parse(req.postData()),
      };
      return route.fulfill({
        status: 201,
        headers: CORS_HEADERS,
        contentType: "application/json",
        body: '{"content":{"sha":"abc123"}}',
      });
    }
    return route.fulfill({ status: 500, headers: CORS_HEADERS, body: "{}" });
  });
  const syncPage = await syncContext.newPage();
  await syncPage.goto(PAGE_URL);

  await syncPage.click(".save-btn"); // no token yet → jumps to sync setup
  assert(
    "26. save button without a token opens the sync setup",
    (await syncPage.$(".sync-token-input")) !== null
  );

  await syncPage.fill(".sync-token-input", "github_pat_TEST");
  await syncPage.click(".sync-token-save");
  await goTab(syncPage, "Today");
  await clickCheckbox(syncPage, "Leg Press", false);
  await syncPage.click(".save-btn");
  await syncPage.waitForFunction(() =>
    document.querySelector(".save-btn").textContent.includes("Saved")
  );
  {
    const sentState = JSON.parse(
      Buffer.from(putRequest.body.content, "base64").toString("utf8")
    );
    assert(
      "27. Save commits state to data/state.json with the token",
      putRequest.url.startsWith(API_FILE_URL) &&
        putRequest.auth === "Bearer github_pat_TEST" &&
        putRequest.body.branch === "main" &&
        putRequest.body.sha === undefined && // 404 → create, no sha
        sentState.sessions[today].checks["Leg Press"] === true,
      JSON.stringify({ url: putRequest.url, auth: putRequest.auth })
    );
  }
  await clickCheckbox(syncPage, "Leg Extension", false);
  assert(
    "28. a new change flips the button back from Saved to Save",
    (await syncPage.$eval(".save-btn", (el) => el.textContent)) === "Save"
  );
  await syncContext.close();

  // Pull path: remote file exists and is newer → adopted on launch.
  const pullContext = await browser.newContext();
  const remoteState = {
    updatedAt: 9999999999999,
    sessions: {
      "2026-01-05": {
        dayNumber: 2,
        checks: { "Lat Pulldown": true },
        weights: {},
        effort: 8,
        notes: "from another device",
      },
    },
    weighIns: { "2026-01-05": 244 },
    weightDrafts: {},
  };
  await pullContext.route("https://api.github.com/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: CORS_HEADERS });
    }
    return route.fulfill({
      status: 200,
      headers: CORS_HEADERS,
      contentType: "application/json",
      body: JSON.stringify({
        sha: "def456",
        content: Buffer.from(JSON.stringify(remoteState)).toString("base64"),
      }),
    });
  });
  const pullPage = await pullContext.newPage();
  await pullPage.addInitScript(() =>
    window.localStorage.setItem("rourke-tracker-gh-token", "github_pat_TEST")
  );
  await pullPage.goto(PAGE_URL);
  await pullPage.waitForFunction(() => {
    const s = JSON.parse(
      window.localStorage.getItem("rourke-tracker-v1") || "{}"
    );
    return s.sessions && Object.keys(s.sessions).length === 1;
  });
  await goTab(pullPage, "History");
  assert(
    "29. newer remote data is adopted on launch",
    (await pullPage.$eval(".session-completion", (el) => el.textContent)) ===
      "1/7 done" &&
      (await pullPage.$$eval(".stat-value", (els) => els[0].textContent)) ===
        "1"
  );
  await pullContext.close();

  // ---------- Rotation across calendar days (fake clock) ----------
  // The exact user scenario: D1 logged Monday (even partially) → the next
  // gym day pre-loads D2, then D3, regardless of schedule or completion.
  console.log("\nRotation across calendar days");
  const rotContext = await browser.newContext();
  const rotPage = await rotContext.newPage();
  await rotPage.clock.install({ time: new Date("2026-03-09T12:00:00") }); // a Monday
  await rotPage.goto(PAGE_URL);
  await clickCheckbox(rotPage, "Warm-Up", false); // partial D1, nothing else
  await rotPage.clock.setFixedTime(new Date("2026-03-10T12:00:00"));
  await rotPage.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  assert(
    "30. partial D1 on Monday → Tuesday pre-loads D2",
    (await activeDayPill(rotPage)) === "D2"
  );
  await clickCheckbox(rotPage, "Chest Press Machine", false); // partial D2
  await rotPage.clock.setFixedTime(new Date("2026-03-12T12:00:00")); // skip a day
  await rotPage.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  assert(
    "31. partial D2 → next visit (a day skipped) pre-loads D3",
    (await activeDayPill(rotPage)) === "D3"
  );
  await rotContext.close();

  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
