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

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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

  console.log("\nAuto-advance (incomplete day keeps being suggested)");
  // Today's Day 3 session has only Leg Press checked → incomplete. A date
  // with no session (yesterday) must still suggest Day 3, not advance.
  await page.$$eval(".date-chip", (els) => els[5].click()); // yesterday
  assert(
    "17. incomplete last session keeps suggesting the same day (D3)",
    (await activeDayPill(page)) === "D3"
  );
  await page.$$eval(".date-chip", (els) => els[6].click()); // back to today

  // Complete every Day 3 exercise, then a fresh date must advance 3 → 1.
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
    "18. all boxes checked shows 7/7 with done styling",
    (await progressBadge(page)) === "7/7" &&
      (await page.$(".progress-badge-done")) !== null
  );
  await page.$$eval(".date-chip", (els) => els[5].click()); // yesterday again
  assert(
    "19. completed Day 3 advances the rotation to Day 1",
    (await activeDayPill(page)) === "D1"
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

  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
