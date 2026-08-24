# calendar-watch

Watches one or more public **iCal / webcal** calendars and emails a **diff** to a
list of recipients whenever events are **added, changed, or removed**. Runs on a
GitHub Actions cron (twice a day by default) — no server or database required.

Email is sent through [Resend](https://resend.com) using the Team Rezy sender
`Team Rezy <contact@updates.teamrezy.com>`.

## How it works

An iCal feed has no "what changed" signal, so change detection works by
comparing each fetch against the previous one:

1. The Action fetches every calendar in `config.json`.
2. It parses each `.ics` into a normalized set of events and computes a signature
   per event.
3. It diffs that against the snapshot committed in `state/<slug>.json`.
4. If anything changed, it emails the diff via Resend.
5. It writes the new snapshot and the workflow **commits it back to the repo**,
   so the next run compares against it.

The **first run** for a calendar just records a baseline — it does not email.

## Setup

### 1. Configure calendars — `config.json`

```json
{
  "fromEmail": "Team Rezy <contact@updates.teamrezy.com>",
  "bcc": [],
  "calendars": [
    {
      "slug": "team-schedule",
      "name": "Team Schedule",
      "url": "webcal://example.com/feed.ics",
      "timezone": "America/New_York",
      "recipients": ["coach@example.com", "manager@example.com"]
    }
  ]
}
```

- `slug` — unique id; also the snapshot filename (`state/<slug>.json`).
- `url` — the `webcal://` or `https://` `.ics` link (webcal is auto-converted).
- `timezone` — IANA tz used as a **fallback** for displaying event times.
  Each event is shown in its own timezone when the feed provides one
  (`DTSTART;TZID=...`); this value is only used for events that carry none.
- `recipients` — who gets the diff email for this calendar.
- `bcc` — optional list applied to every email (e.g. an archive address).

Add more objects to `calendars` to watch multiple feeds.

### 2. Add the Resend API key as a repo secret

Settings → Secrets and variables → Actions → **New repository secret**:

- Name: `RESEND_API_KEY`
- Value: your Resend API key (must be allowed to send from
  `updates.teamrezy.com`)

Without the secret the job still runs but only logs the diff (dry run).

### 3. Done

The workflow (`.github/workflows/calendar-watch.yml`) runs at **13:00** and
**01:00 UTC**. Adjust the `cron:` lines to change the times. To trigger a run
manually, use the **Run workflow** button on the Actions tab (`workflow_dispatch`).

## Run locally

```bash
npm install
RESEND_API_KEY=your_key node check-calendar.mjs
# omit RESEND_API_KEY for a dry run that only logs what it would send
```

Note: running locally writes/updates `state/*.json`. Commit those (or let the
Action own them) so the baseline stays consistent.

## Notes

- Recurring events are compared by their series definition, so a recurring event
  produces one diff entry rather than one per occurrence.
- The snapshot commit uses `[skip ci]` and the workflow only triggers on a
  schedule / manual dispatch, so there is no risk of a commit loop.
- If your default branch has protection rules that block the `github-actions[bot]`
  push, allow that actor to bypass, or point the workflow at an unprotected
  branch for the snapshot commits.
