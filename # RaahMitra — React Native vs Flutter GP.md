# RaahMitra — React Native vs Flutter GPS Test Plan
**Goal: Decide the mobile framework with real data, not a spec sheet, before Phase 1 MVP build begins.**

---

## Why This Test Exists

RaahMitra's core safety features (live location, signal map, SOS) all depend on **background GPS tracking working reliably on budget Android phones** (Redmi 9A class, 2–3GB RAM — your actual target user). A framework that looks fine on paper can silently fail in the background, get killed by Android's battery optimizer, or drain the battery too fast for a biker on a mountain road. This test settles it with evidence instead of guesswork.

---

## Phase 1 — Setup (Day 1)

### 1.1 Build Two Throwaway Logger Apps
Not real apps — just a minimal GPS logger, built twice: once in React Native, once in Flutter.

**Each app must, every 30 seconds (adjustable), log to a local file/DB:**
| Field | Example |
|---|---|
| Timestamp | 2026-08-11 14:32:05 |
| Latitude, Longitude | 32.1234, 77.5678 |
| GPS accuracy (meters) | 8.2 |
| Battery % | 74% |
| App state | foreground / background |
| Location method used | GPS / fused / network |

**Requirements:**
- Use the same logging interval in both apps.
- Use the each framework's standard background-location approach:
  - React Native → `react-native-background-geolocation` or `expo-location` background task
  - Flutter → `geolocator` + `flutter_background_service`
- Write logs to local storage (SQLite or plain JSON file) — no server needed, no internet dependency for the test itself.
- Add a simple on-screen counter/status so you can visually confirm the app is still running.

### 1.2 Prepare the Test Device
- Use a **Redmi 9A-class phone** (2–3GB RAM) — matches your real target user.
- Fully charge before each day's testing.
- Note Android version and confirm default settings (don't pre-optimize anything — you want real-world default behavior).
- Install both apps but only run **one at a time**.

### 1.3 Prepare the Route
- Pick one fixed route with a **mix of good and weak/no-signal zones** (a Shimla outskirts road works well).
- Use the same route, same direction, same rough time of day for every run — this keeps comparisons fair.

---

## Phase 2 — Run the 6 Scenarios (Days 2–4)

Run **all 6 scenarios for React Native first, then all 6 for Flutter** (not simultaneously — conditions like signal and battery need to be comparable, not identical-instant).

| # | Scenario | How to trigger it |
|---|---|---|
| 1 | Foreground, good signal | Keep app open, screen on, standard network area |
| 2 | App minimized, good signal | Press home button, leave running, standard network area |
| 3 | App minimized, weak/no signal | Same as above, drive into a known weak-signal stretch |
| 4 | Phone idle 30+ minutes | Leave phone untouched, screen off, for 30+ min mid-route |
| 5 | Default battery optimization ON | Do not disable Android's battery optimization for the app |
| 6 | Low battery (<20%) | Run the same route again once battery drops below 20% |

**Repeat the full 6-scenario cycle 2–3 times, on different days**, to rule out one-off noise (a single day of unusually bad signal, etc.)

---

## Phase 3 — Collect & Compare Results

After each run, pull the log file and fill in this table:

| Metric | React Native | Flutter | Notes |
|---|---|---|---|
| Update frequency consistency (on-schedule vs drifted) | | | |
| Longest unexplained gap in logging | | | |
| Was the background service killed by Android? (Y/N, how many times) | | | |
| GPS accuracy (avg meters off from known reference point) | | | |
| Battery drain per hour | | | |
| Recovery behavior after being killed (auto-restart? user has to reopen?) | | | |

**How to check "was it killed":** look for gaps in the log timestamps longer than 2–3x your logging interval with no corresponding "idle/no movement" explanation.

**How to check GPS accuracy:** stand at 3–4 known fixed points along the route (a landmark you can pinpoint on Google Maps) and compare the logged coordinate to the real one.

---

## Phase 4 — Apply the Decision Rule

- **Small gap between the two** (both track reliably, similar battery drain, no major kill issues) → **go with React Native** — keeps your team's TypeScript advantage for free.
- **Large gap** (Flutter clearly tracks more reliably, survives background/idle better, drains less battery) → **switch to Flutter now**, before the real MVP build starts. Better to lose a few days now than rebuild mid-Phase-1.

---

## Timeline Summary

| Day | Activity |
|---|---|
| 1 | Build both logger apps, prep device and route |
| 2 | Run all 6 scenarios — React Native |
| 3 | Run all 6 scenarios — Flutter |
| 4 | Repeat cycle (round 2) for both, to confirm results aren't a fluke |
| 5 | Compile comparison table, apply decision rule, finalize framework choice |

*Total time: ~5 days, before company registration or MVP spend — this sits right after the Shimla pilot decision in Phase 0.*

---

*RaahMitra Confidential · Phase 0 Technical Decision Plan*