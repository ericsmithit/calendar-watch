/**
 * calendar-watch
 *
 * Fetches each configured public iCal/webcal calendar, compares it against the
 * snapshot stored in state/<slug>.json, and — when events have been added,
 * removed, or changed — emails the diff via Resend.
 *
 * State (the snapshot) is committed back to the repo by the GitHub Actions
 * workflow, so each run compares against the previous run. The first run for a
 * calendar establishes a baseline and does NOT send an email.
 *
 * Env:
 *   RESEND_API_KEY   required to send email (dry-run logs the diff if missing)
 *
 * Exit code is non-zero if any calendar failed to fetch/parse, so the failure
 * surfaces in the Actions UI. Snapshots for successful calendars are still
 * written (the commit step runs with if: always()).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ical from "node-ical";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");
const STATE_DIR = join(__dirname, "state");
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);
  if (!Array.isArray(config.calendars) || config.calendars.length === 0) {
    throw new Error("config.json must define a non-empty 'calendars' array");
  }
  return config;
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

function toHttpUrl(url) {
  // webcal:// is just http(s):// for iCal subscriptions.
  return url.replace(/^webcal:\/\//i, "https://");
}

async function fetchCalendar(url) {
  const res = await fetch(toHttpUrl(url), {
    headers: { "User-Agent": "calendar-watch/1.0 (+github-actions)" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }
  return res.text();
}

/**
 * Normalize an .ics document into a map of { key -> { sig, summary, when } }.
 *
 * key       stable identity for an event (uid, plus recurrence-id for overrides)
 * sig       signature of the salient fields; a change here means the event changed
 * summary   title, for display in the email
 * when      human-readable start, for display in the email
 *
 * Recurring events are compared by their DEFINITION (one entry per series), not
 * by expanding every occurrence — that keeps the diff meaningful instead of noisy.
 */
function normalize(icsText, timezone) {
  const data = ical.sync.parseICS(icsText);
  const events = {};

  const addEvent = (ev, keySuffix = "") => {
    if (!ev || ev.type !== "VEVENT") return;
    const uid = ev.uid || ev.summary || JSON.stringify(ev.start);
    const key = keySuffix ? `${uid}::${keySuffix}` : uid;

    const start = ev.start ? new Date(ev.start).toISOString() : "";
    const end = ev.end ? new Date(ev.end).toISOString() : "";
    const rrule = ev.rrule ? ev.rrule.toString() : "";

    const sig = [
      (ev.summary || "").trim(),
      (ev.location || "").trim(),
      start,
      end,
      (ev.description || "").trim(),
      (ev.status || "").trim(),
      rrule,
    ].join("|");

    // Display each event in the timezone where it actually happens. node-ical
    // attaches the event's TZID (from DTSTART;TZID=...) as ev.start.tz; fall
    // back to the calendar's configured default when an event carries none.
    const eventTz = (ev.start && ev.start.tz) || timezone;

    events[key] = {
      sig,
      summary: (ev.summary || "(no title)").trim(),
      when: formatWhen(ev.start, eventTz),
    };
  };

  for (const value of Object.values(data)) {
    if (!value || value.type !== "VEVENT") continue;
    addEvent(value);
    // Overridden instances of a recurring series (each is its own VEVENT).
    if (value.recurrences && typeof value.recurrences === "object") {
      for (const [recurId, override] of Object.entries(value.recurrences)) {
        addEvent(override, recurId);
      }
    }
  }

  return events;
}

function formatWhen(date, timezone) {
  if (!date) return "unknown time";
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
      timeZoneName: "short",
    }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

// ---------------------------------------------------------------------------
// State (snapshot) persistence
// ---------------------------------------------------------------------------

async function loadState(slug) {
  try {
    const raw = await readFile(join(STATE_DIR, `${slug}.json`), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null; // first run for this calendar
    throw err;
  }
}

async function saveState(slug, state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    join(STATE_DIR, `${slug}.json`),
    JSON.stringify(state, null, 2) + "\n",
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function diff(prevEvents, currEvents) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, curr] of Object.entries(currEvents)) {
    const prev = prevEvents[key];
    if (!prev) {
      added.push(curr);
    } else if (prev.sig !== curr.sig) {
      changed.push({ before: prev, after: curr });
    }
  }
  for (const [key, prev] of Object.entries(prevEvents)) {
    if (!currEvents[key]) removed.push(prev);
  }

  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function buildEmail(calendar, changes) {
  const { added, removed, changed } = changes;
  const total = added.length + removed.length + changed.length;
  const subject = `${calendar.name} Calendar updated: (${total} change${
    total === 1 ? "" : "s"
  })`;

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const section = (title, color, items) =>
    items.length
      ? `<h3 style="margin:20px 0 8px;color:${color};font-size:15px;">${title} (${items.length})</h3>` +
        items
          .map(
            (it) =>
              `<div style="padding:8px 12px;margin:6px 0;background:#f8fafc;border-left:3px solid ${color};border-radius:4px;">` +
              `<strong>${esc(it.summary)}</strong><br>` +
              `<span style="color:#6b7280;font-size:13px;">${esc(it.when)}</span></div>`
          )
          .join("")
      : "";

  const changedSection = changed.length
    ? `<h3 style="margin:20px 0 8px;color:#b45309;font-size:15px;">Changed (${changed.length})</h3>` +
      changed
        .map(
          ({ before, after }) =>
            `<div style="padding:8px 12px;margin:6px 0;background:#fffbeb;border-left:3px solid #b45309;border-radius:4px;">` +
            `<strong>${esc(after.summary)}</strong><br>` +
            `<span style="color:#6b7280;font-size:13px;">Now: ${esc(after.when)}</span>` +
            (before.when !== after.when
              ? `<br><span style="color:#9ca3af;font-size:12px;text-decoration:line-through;">Was: ${esc(
                  before.when
                )}</span>`
              : "") +
            `</div>`
        )
        .join("")
    : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <div style="background:linear-gradient(135deg,#1e40af,#3b82f6);color:#fff;padding:24px;border-radius:8px 8px 0 0;">
        <div style="font-size:20px;font-weight:bold;">Team Rezy</div>
        <div style="opacity:.9;">Schedule change detected</div>
      </div>
      <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
        <p>The calendar <strong>${esc(calendar.name)}</strong> has ${total} update${
    total === 1 ? "" : "s"
  }:</p>
        ${section("Added", "#047857", added)}
        ${changedSection}
        ${section("Removed", "#b91c1c", removed)}
        <p style="margin-top:24px;color:#9ca3af;font-size:12px;">
          Automated by calendar-watch. Detected ${new Date().toISOString()}.
        </p>
      </div>
    </div>`;

  const line = (prefix, it) => `  ${prefix} ${it.summary} — ${it.when}`;
  const text = [
    `${calendar.name}: ${total} calendar update(s)`,
    "",
    ...(added.length ? ["Added:", ...added.map((it) => line("+", it)), ""] : []),
    ...(changed.length
      ? [
          "Changed:",
          ...changed.map(({ before, after }) =>
            before.when !== after.when
              ? `  ~ ${after.summary} — now ${after.when} (was ${before.when})`
              : `  ~ ${after.summary} — ${after.when}`
          ),
          "",
        ]
      : []),
    ...(removed.length ? ["Removed:", ...removed.map((it) => line("-", it)), ""] : []),
  ].join("\n");

  return { subject, html, text };
}

async function sendEmail(config, calendar, email) {
  if (!RESEND_API_KEY) {
    console.log(
      `[dry-run] RESEND_API_KEY not set — would email ${calendar.recipients.join(
        ", "
      )}: ${email.subject}`
    );
    return;
  }

  const payload = {
    from: config.fromEmail,
    to: calendar.recipients,
    subject: email.subject,
    html: email.html,
    text: email.text,
  };
  if (Array.isArray(config.bcc) && config.bcc.length) payload.bcc = config.bcc;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed: HTTP ${res.status} ${body}`);
  }
  const data = await res.json().catch(() => ({}));
  console.log(`Email sent to ${calendar.recipients.join(", ")} (id: ${data.id || "n/a"})`);
}

// ---------------------------------------------------------------------------
// Per-calendar run
// ---------------------------------------------------------------------------

async function processCalendar(config, calendar) {
  if (!calendar.slug) throw new Error("Each calendar needs a 'slug'");
  if (!calendar.url || calendar.url.includes("REPLACE_WITH")) {
    throw new Error(`Calendar '${calendar.slug}' has no real url configured`);
  }

  console.log(`\n=== ${calendar.name} (${calendar.slug}) ===`);
  const icsText = await fetchCalendar(calendar.url);
  const currEvents = normalize(icsText, calendar.timezone);
  console.log(`Fetched ${Object.keys(currEvents).length} event(s)`);

  const prevState = await loadState(calendar.slug);
  const newState = {
    name: calendar.name,
    url: calendar.url,
    updatedAt: new Date().toISOString(),
    events: currEvents,
  };

  if (!prevState) {
    console.log("First run — establishing baseline, no email sent.");
    await saveState(calendar.slug, newState);
    return;
  }

  const changes = diff(prevState.events || {}, currEvents);
  const total = changes.added.length + changes.removed.length + changes.changed.length;

  if (total === 0) {
    console.log("No changes.");
    // Still refresh updatedAt-less: skip rewrite to avoid noisy commits.
    return;
  }

  console.log(
    `Changes: +${changes.added.length} ~${changes.changed.length} -${changes.removed.length}`
  );
  if (!calendar.recipients || calendar.recipients.length === 0) {
    console.warn(`Calendar '${calendar.slug}' has no recipients — skipping email.`);
  } else {
    const email = buildEmail(calendar, changes);
    await sendEmail(config, calendar, email);
  }

  await saveState(calendar.slug, newState);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = await loadConfig();
  let failures = 0;

  for (const calendar of config.calendars) {
    try {
      await processCalendar(config, calendar);
    } catch (err) {
      failures += 1;
      console.error(`ERROR [${calendar.slug || "?"}]: ${err.message}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} calendar(s) failed.`);
    process.exit(1);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
