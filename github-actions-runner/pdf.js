// Renders an itinerary to PDF with headless Chrome, using the approved
// "TripWiser Itinerary" design (editorial layout: Playfair Display headlines,
// Lora body, Jost labels, pink/teal accents on navy).
//
// Why Chrome instead of the Google Docs export Webhook.gs used to do: the
// design depends on things Docs can't express - blocks that never split
// across pages (break-inside: avoid), deliberate page breaks, a running
// header/footer with hairline rules, letter-spaced labels, and real CSS
// grids. Chrome's print engine handles all of it, so the PDF matches the
// design file page-for-page.
//
// Pagination (mirrors the design):
//   Page 1      - eyebrow, headline, summary, trip-facts strip, traveller
//                 details + trip-team card, trip-at-a-glance table
//   Page 2..n   - "Day by day", one unbreakable block per day
//   Final page  - "Before you go" tips, "What happens next", closing banner
//
// Fonts are embedded from @fontsource packages as data URIs, so rendering
// never depends on network access to Google Fonts from the runner.

const fs = require("fs");
const path = require("path");

const TRIP_TIMEZONE = process.env.TRIP_TIMEZONE || "Asia/Kolkata";
const PAPER_FORMAT = (process.env.PDF_PAPER || "letter").toLowerCase() === "a4" ? "A4" : "Letter";
const PAPER_INCHES = PAPER_FORMAT === "A4" ? { width: 8.27, height: 11.69 } : { width: 8.5, height: 11 };
const MARGIN_INCHES = { top: 0.95, bottom: 0.95, side: 0.7 };
const CSS_PX_PER_INCH = 96;

const TEAM_NAME = "Team 1TripWiser";
const TEAM_EMAIL = "1tripwiser@gmail.com";
const TEAM_WHATSAPP_DISPLAY = "+91 87967 17771";
const TEAM_WHATSAPP_URL = "https://wa.me/918796717771";
const SITE_URL = "https://1tripwiser.com";
const SIGNUP_URL = "https://1tripwiser.com/register/";
const BLOG_URL = "https://1tripwiser.com/blog-affiliates/";
const TRIBE_URL = "https://1tripwiser.com/tribe/";
const SOCIAL_LINKS = [
  ["Instagram", "https://www.instagram.com/1tripwiser/"],
  ["Facebook", "https://www.facebook.com/1tripwiser/"],
  ["YouTube", "https://www.youtube.com/1tripwiser"],
  ["LinkedIn", "https://www.linkedin.com/company/1tripwiser/"],
  ["Twitter", "https://twitter.com/1tripwiser"],
];

const SLOTS = ["Morning", "Afternoon", "Evening"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------------------
// Fonts

function fontFace(family, pkg, file, weight, style) {
  const filePath = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files", file);
  const data = fs.readFileSync(filePath).toString("base64");
  return `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');}`;
}

let fontCssCache = null;
function allFontsCss() {
  if (!fontCssCache) {
    fontCssCache = [
      fontFace("Jost", "@fontsource/jost", "jost-latin-400-normal.woff2", 400, "normal"),
      fontFace("Jost", "@fontsource/jost", "jost-latin-500-normal.woff2", 500, "normal"),
      fontFace("Lora", "@fontsource/lora", "lora-latin-400-normal.woff2", 400, "normal"),
      fontFace("Lora", "@fontsource/lora", "lora-latin-400-italic.woff2", 400, "italic"),
      fontFace("Lora", "@fontsource/lora", "lora-latin-600-normal.woff2", 600, "normal"),
      fontFace("Playfair Display", "@fontsource/playfair-display", "playfair-display-latin-400-normal.woff2", 400, "normal"),
      fontFace("Playfair Display", "@fontsource/playfair-display", "playfair-display-latin-400-italic.woff2", 400, "italic"),
    ].join("\n");
  }
  return fontCssCache;
}

// The running header/footer render in their own isolated context and can't
// see the page's fonts, so they get just the two Jost weights they use.
let chromeFontCssCache = null;
function chromeFontsCss() {
  if (!chromeFontCssCache) {
    chromeFontCssCache =
      fontFace("Jost", "@fontsource/jost", "jost-latin-400-normal.woff2", 400, "normal") +
      fontFace("Jost", "@fontsource/jost", "jost-latin-500-normal.woff2", 500, "normal");
  }
  return chromeFontCssCache;
}

// ---------------------------------------------------------------------------
// Formatting helpers

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Returns a UTC-midnight Date for the calendar day the traveller meant, or
// null. Sheet dates arrive either as "yyyy-MM-dd" (current Webhook.gs) or as
// a UTC ISO timestamp of local midnight (older deployments), e.g.
// "2026-09-23T18:30:00.000Z" for 24 Sep in IST - reading that naively is
// what shifted every day's date back by one.
function parseCalendarDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  const plain = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (plain) return new Date(Date.UTC(+plain[1], +plain[2] - 1, +plain[3]));

  const ms = Date.parse(str);
  if (Number.isNaN(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TRIP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => +parts.find((p) => p.type === type).value;
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}

function fmtDayMonth(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function fmtWeekdayDayMonth(d) {
  return `${WEEKDAYS[d.getUTCDay()]} ${fmtDayMonth(d)}`;
}

function fmtLong(d) {
  return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "24 – 30 Sep", or "28 Sep – 4 Oct" when the trip crosses a month.
function fmtRange(start, end) {
  if (!end || start.getTime() === end.getTime()) return fmtDayMonth(start);
  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${start.getUTCDate()} – ${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]}`;
  }
  return `${fmtDayMonth(start)} – ${fmtDayMonth(end)}`;
}

function todayInTripZone() {
  return parseCalendarDate(new Date().toISOString());
}

function plural(n, one, many) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}

function formatPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return String(raw || "");
}

// Bolds nothing, italicises the LLM's chosen highlight words in pink (the
// design's "Kashmir Escape with *Gulmarg* and *Pahalgam*" treatment).
function renderHeadline(itinerary, destination, dayCount) {
  const title = String(itinerary.title || "").trim();
  if (!title) {
    return `${dayCount ? esc(plural(dayCount, "day", "days")) + " in " : ""}<em>${esc(destination)}</em>`;
  }
  let html = esc(title);
  let highlighted = false;
  const highlights = Array.isArray(itinerary.titleHighlights) ? itinerary.titleHighlights : [];
  highlights
    .map((h) => esc(String(h || "").trim()))
    .filter((h) => h.length > 1)
    .forEach((h) => {
      const i = html.indexOf(h);
      if (i === -1 || html.slice(0, i).lastIndexOf("<em>") > html.slice(0, i).lastIndexOf("</em>")) return;
      html = `${html.slice(0, i)}<em>${h}</em>${html.slice(i + h.length)}`;
      highlighted = true;
    });
  if (!highlighted && destination) {
    const d = esc(destination);
    const i = html.indexOf(d);
    if (i !== -1) html = `${html.slice(0, i)}<em>${d}</em>${html.slice(i + d.length)}`;
  }
  return html;
}

function tripReference(trip, start, destination) {
  const d = start || todayInTripZone();
  const yymm = String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, "0");
  const code = String(destination || "TRP").replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase() || "TRP";
  return `TW-${yymm}-${code}-${String(trip.rowNumber || 0).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Model

function buildModel(trip, itinerary) {
  const destination = String(itinerary.destination || trip.destination || "Your trip").trim();
  const days = Array.isArray(itinerary.days) ? itinerary.days : [];
  const start = parseCalendarDate(trip.travelDate);
  const end = start && days.length ? addDays(start, days.length - 1) : null;

  const dayDate = (day, idx) => {
    if (start) return addDays(start, idx);
    return parseCalendarDate(day && day.date && /^\d{4}-\d{2}-\d{2}$/.test(String(day.date).trim()) ? day.date : null);
  };

  const party = [];
  if (Number(trip.adults)) party.push(plural(trip.adults, "adult", "adults"));
  if (Number(trip.children)) party.push(plural(trip.children, "child", "children"));

  const facts = [];
  if (days.length) facts.push(["Duration", days.length > 1 ? `${days.length - 1}N / ${days.length}D` : "1 day"]);
  else if (trip.duration) facts.push(["Duration", String(trip.duration)]);
  if (start) facts.push(["Travel dates", fmtRange(start, end)]);
  else if (trip.travelDate) facts.push(["Travel dates", String(trip.travelDate)]);
  if (party.length) facts.push(["Travellers", party.join(", ")]);
  if (trip.tripType) facts.push(["Trip type", String(trip.tripType)]);
  if (trip.departingFrom) facts.push(["Departing from", String(trip.departingFrom)]);
  else if (trip.budget) facts.push(["Budget", String(trip.budget)]);

  const details = [];
  if (trip.name) details.push(["Lead traveller", String(trip.name)]);
  if (party.length) details.push(["Party", party.length === 1 && !Number(trip.children) ? `${party[0]} · no children` : party.join(" · ")]);
  const contact = [formatPhone(trip.phone), trip.email].filter(Boolean).join(" · ");
  if (contact) details.push(["Contact", contact]);
  if (trip.budget) details.push(["Budget", String(trip.budget)]);
  if (trip.timePreference) details.push(["Preferred timing", String(trip.timePreference)]);
  details.push(["Reference", tripReference(trip, start, destination)]);
  details.push(["Prepared on", fmtLong(todayInTripZone())]);

  return {
    destination,
    headline: renderHeadline(itinerary, destination, days.length),
    summary: itinerary.summary ? String(itinerary.summary) : "",
    headerRight: start ? `${destination} · ${fmtRange(start, end)}` : destination,
    facts: facts.slice(0, 5),
    details,
    days: days.map((day, idx) => ({ day: day || {}, idx, date: dayDate(day, idx) })),
    tips: (Array.isArray(itinerary.tips) ? itinerary.tips : [])
      .map((tip, i) =>
        typeof tip === "string"
          ? { label: `Tip ${String(i + 1).padStart(2, "0")}`, text: tip }
          : { label: String((tip && (tip.label || tip.title)) || `Tip ${String(i + 1).padStart(2, "0")}`), text: String((tip && (tip.text || tip.detail || tip.description)) || "") }
      )
      .filter((tip) => tip.text.trim()),
  };
}

// ---------------------------------------------------------------------------
// HTML

const CSS = `
  @page { size: ${PAPER_FORMAT}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { color: #0d1526; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  a { color: #1B93B0; text-decoration: none; }

  .eyebrow { font: 500 9px/1 'Jost', sans-serif; letter-spacing: 0.22em; text-transform: uppercase; color: #e5127d; margin: 6px 0 14px; }
  .label { font: 500 9px/1 'Jost', sans-serif; letter-spacing: 0.2em; text-transform: uppercase; color: #1B93B0; margin-bottom: 12px; }
  .label.muted { color: #8a93a3; }
  .micro { font: 500 8px/1 'Jost', sans-serif; letter-spacing: 0.18em; text-transform: uppercase; color: #8a93a3; }

  h1 { font: 400 40px/1.08 'Playfair Display', serif; color: #0d1526; margin: 0 0 12px; letter-spacing: -0.01em; max-width: 6.4in; }
  h1 em, .banner-line em { font-style: italic; color: #e5127d; }
  h2 { font: 400 26px/1.2 'Playfair Display', serif; color: #0d1526; margin: 0 0 4px; break-after: avoid; }
  .lede { font: 400 13.5px/1.65 'Lora', serif; color: #4b5565; margin: 0 0 22px; max-width: 5.6in; }
  .sub { font: 400 11px/1.6 'Lora', serif; color: #8a93a3; margin: 0 0 4px; max-width: 5in; }

  .facts { display: grid; border-top: 2px solid #0d1526; border-bottom: 1px solid #e3e6ec; break-inside: avoid; margin-bottom: 26px; }
  .fact { padding: 12px 14px; border-right: 1px solid #e3e6ec; min-width: 0; }
  .fact:first-child { padding-left: 0; }
  .fact:last-child { padding-right: 0; border-right: 0; }
  .fact .micro { margin-bottom: 6px; }
  .fact-value { font: 400 17px/1.2 'Playfair Display', serif; color: #0d1526; }

  .intro-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 26px; break-inside: avoid; margin-bottom: 26px; }
  table { width: 100%; border-collapse: collapse; font: 400 11px/1.5 'Jost', sans-serif; color: #0d1526; }
  .kv td { padding: 7px 0; border-bottom: 1px solid #eef0f4; vertical-align: top; }
  .kv tr:last-child td { border-bottom: 0; }
  .kv td:first-child { color: #8a93a3; width: 38%; padding-right: 10px; }
  .kv td:last-child { word-break: break-word; }

  .planner { background: #f6f7f9; border-left: 3px solid #e5127d; padding: 16px 18px; }
  .planner .label { margin-bottom: 10px; }
  .planner-name { font: 400 20px/1.2 'Playfair Display', serif; color: #0d1526; margin-bottom: 4px; }
  .planner-role { font: 400 10.5px/1.5 'Jost', sans-serif; color: #5b6475; margin-bottom: 12px; }
  .planner-lines { font: 400 10.5px/1.8 'Jost', sans-serif; color: #0d1526; }
  .planner-lines a { color: #0d1526; }
  .planner-note { margin-top: 14px; padding-top: 12px; border-top: 1px solid #e3e6ec; font: italic 400 10px/1.6 'Lora', serif; color: #5b6475; }

  .glance { break-inside: avoid; }
  .glance-cols { display: grid; gap: 24px; }
  .grid-table th { text-align: left; padding: 0 10px 8px 0; border-bottom: 2px solid #0d1526; font: 500 8px/1 'Jost', sans-serif; letter-spacing: 0.18em; text-transform: uppercase; color: #8a93a3; }
  .grid-table td { padding: 6px 10px 6px 0; border-bottom: 1px solid #eef0f4; vertical-align: baseline; line-height: 1.4; }
  .grid-table tr:last-child td { border-bottom: 0; }
  .grid-table .num { color: #e5127d; font-family: 'Playfair Display', serif; font-size: 12.5px; width: 34px; }
  .grid-table .when { white-space: nowrap; color: #5b6475; width: 88px; }

  .page-break { break-before: page; }

  .day { break-inside: avoid; margin-top: 22px; padding-top: 16px; border-top: 1px solid #e3e6ec; }
  .day-head { display: flex; gap: 16px; align-items: baseline; margin-bottom: 12px; }
  .day-num { font: 400 30px/1 'Playfair Display', serif; color: #e5127d; min-width: 0.52in; }
  .day-eyebrow { font: 500 8.5px/1 'Jost', sans-serif; letter-spacing: 0.18em; text-transform: uppercase; color: #1B93B0; margin-bottom: 5px; }
  .day-title { font: 400 17px/1.3 'Playfair Display', serif; color: #0d1526; }
  .slots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin-left: calc(0.52in + 16px); }
  .slot .micro { margin-bottom: 6px; letter-spacing: 0.16em; }
  .act + .act { margin-top: 10px; }
  .act-title { font: 600 10.5px/1.45 'Lora', serif; color: #0d1526; margin-bottom: 3px; }
  .act-detail { font: 400 10px/1.6 'Lora', serif; color: #4b5565; margin: 0 0 3px; }
  .act-empty { font: italic 400 10px/1.6 'Lora', serif; color: #8a93a3; }
  .extras { margin: 12px 0 0 calc(0.52in + 16px); padding-top: 10px; border-top: 1px dashed #e3e6ec; }
  .extras .act-title .micro { display: inline; margin-right: 6px; color: #1B93B0; }

  .section { margin: 38px 0 0; break-inside: avoid; }
  .section h2 { margin-bottom: 16px; }
  .banner { margin-top: 30px; }
  .tips { display: grid; gap: 20px 22px; border-top: 2px solid #0d1526; padding-top: 16px; }
  .tip { break-inside: avoid; }
  .tip-label { font: 500 8.5px/1.3 'Jost', sans-serif; letter-spacing: 0.16em; text-transform: uppercase; color: #e5127d; margin-bottom: 7px; }
  .tip-text { font: 400 10.5px/1.65 'Lora', serif; color: #0d1526; }

  .steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border-top: 1px solid #e3e6ec; border-bottom: 1px solid #e3e6ec; break-inside: avoid; }
  .step { padding: 14px 16px; border-right: 1px solid #e3e6ec; }
  .step:first-child { padding-left: 0; }
  .step:last-child { border-right: 0; padding-right: 0; }
  .step-num { font: 400 22px/1 'Playfair Display', serif; color: #1B93B0; margin-bottom: 8px; }
  .step-title { font: 500 8.5px/1 'Jost', sans-serif; letter-spacing: 0.16em; text-transform: uppercase; color: #0d1526; margin-bottom: 7px; }
  .step-text { font: 400 10.5px/1.65 'Lora', serif; color: #5b6475; }

  .banner { background: #0d1526; padding: 24px 26px; break-inside: avoid; }
  .banner .eyebrow { margin: 0 0 10px; letter-spacing: 0.2em; font-size: 8.5px; }
  .banner-line { font: 400 24px/1.25 'Playfair Display', serif; color: #f7f8fa; margin-bottom: 12px; max-width: 5.4in; }
  .banner-contact { font: 400 10.5px/1.7 'Jost', sans-serif; color: #9aa4b4; }
  .banner-contact a { color: #1B93B0; }
  .banner-links { margin-top: 12px; padding-top: 12px; border-top: 1px solid #1f2a40; display: flex; justify-content: space-between; gap: 16px; font: 500 8px/1.4 'Jost', sans-serif; letter-spacing: 0.16em; text-transform: uppercase; }
  .banner-links a { color: #9aa4b4; }
  .banner-links a.cta { color: #e5127d; }
  .dot { color: #3a4660; padding: 0 6px; }
`;

function renderFacts(facts) {
  if (!facts.length) return "";
  return `<div class="facts" style="grid-template-columns:repeat(${facts.length},minmax(0,1fr))">${facts
    .map(([label, value]) => `<div class="fact"><div class="micro">${esc(label)}</div><div class="fact-value">${esc(value)}</div></div>`)
    .join("")}</div>`;
}

function renderIntroGrid(model) {
  const rows = model.details.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  return `
  <div class="intro-grid">
    <div>
      <div class="label">Traveller &amp; trip details</div>
      <table class="kv"><tbody>${rows}</tbody></table>
    </div>
    <div class="planner">
      <div class="label muted">Your trip team</div>
      <div class="planner-name">${esc(TEAM_NAME)}</div>
      <div class="planner-role">Itinerary specialists · here before, during and after your trip</div>
      <div class="planner-lines">
        <div><a href="${TEAM_WHATSAPP_URL}">${esc(TEAM_WHATSAPP_DISPLAY)}</a> (WhatsApp)</div>
        <div><a href="mailto:${TEAM_EMAIL}">${esc(TEAM_EMAIL)}</a></div>
      </div>
      <div class="planner-note">Anything you want moved, added or slowed down — message us and we will re-cut the plan around you.</div>
    </div>
  </div>`;
}

function renderGlance(model) {
  if (!model.days.length) return "";
  const row = ({ day, idx, date }) =>
    `<tr><td class="num">${String(idx + 1).padStart(2, "0")}</td>` +
    `<td class="when">${date ? esc(fmtWeekdayDayMonth(date)) : "Day " + (idx + 1)}</td>` +
    `<td>${esc(day.location || day.title || "")}${day.location && day.title ? `<span style="color:#8a93a3"> — ${esc(day.title)}</span>` : ""}</td></tr>`;
  const table = (items) =>
    `<table class="grid-table"><thead><tr><th>Day</th><th>Date</th><th>Where &amp; what</th></tr></thead><tbody>${items.map(row).join("")}</tbody></table>`;

  // Long trips split into two side-by-side tables so the overview still
  // fits on the first page instead of spilling onto its own.
  const split = model.days.length > 8;
  const half = Math.ceil(model.days.length / 2);
  const body = split
    ? `<div class="glance-cols" style="grid-template-columns:1fr 1fr">${table(model.days.slice(0, half))}${table(model.days.slice(half))}</div>`
    : table(model.days);

  return `
  <div class="glance">
    <div class="label">Trip at a glance</div>
    ${body}
  </div>`;
}

function renderActivity(activity, withTimeLabel) {
  const title = activity.title || "";
  const details =
    Array.isArray(activity.details) && activity.details.length
      ? activity.details
      : activity.description
      ? [activity.description]
      : [];
  const timeLabel = withTimeLabel && activity.time ? `<span class="micro">${esc(activity.time)}</span>` : "";
  return `<div class="act">${title || timeLabel ? `<div class="act-title">${timeLabel}${esc(title)}</div>` : ""}${details
    .filter((d) => String(d || "").trim())
    .map((d) => `<p class="act-detail">${esc(d)}</p>`)
    .join("")}</div>`;
}

function renderDay({ day, idx, date }) {
  const buckets = { Morning: [], Afternoon: [], Evening: [] };
  const extras = [];
  (Array.isArray(day.activities) ? day.activities : []).forEach((activity) => {
    if (!activity) return;
    const time = String(activity.time || "").trim().toLowerCase();
    const slot = SLOTS.find((s) => time === s.toLowerCase() || time.startsWith(s.toLowerCase()));
    if (slot) buckets[slot].push(activity);
    else extras.push(activity);
  });

  const eyebrow = [date ? fmtWeekdayDayMonth(date) : `Day ${idx + 1}`, day.location].filter(Boolean).join(" · ");
  const slotsHtml = SLOTS.map(
    (slot) =>
      `<div class="slot"><div class="micro">${slot}</div>${
        buckets[slot].length ? buckets[slot].map((a) => renderActivity(a, false)).join("") : `<div class="act-empty">At leisure</div>`
      }</div>`
  ).join("");

  return `
  <div class="day">
    <div class="day-head">
      <div class="day-num">${String(idx + 1).padStart(2, "0")}</div>
      <div>
        <div class="day-eyebrow">${esc(eyebrow)}</div>
        <div class="day-title">${esc(day.title || `Day ${idx + 1}`)}</div>
      </div>
    </div>
    <div class="slots">${slotsHtml}</div>
    ${extras.length ? `<div class="extras">${extras.map((a) => renderActivity(a, true)).join("")}</div>` : ""}
  </div>`;
}

function renderClosing(model) {
  // 2 or 4 tips read as a 2-column block; anything else as the design's
  // 3-column row, so a lone tip never dangles on its own line.
  const tipColumns = model.tips.length === 2 || model.tips.length === 4 ? 2 : 3;
  const tips = model.tips.length
    ? `<div class="section">
        <h2>Before you go</h2>
        <div class="tips" style="grid-template-columns:repeat(${tipColumns},minmax(0,1fr))">${model.tips
          .map((tip) => `<div class="tip"><div class="tip-label">${esc(tip.label)}</div><div class="tip-text">${esc(tip.text)}</div></div>`)
          .join("")}</div>
      </div>`
    : "";

  const steps = [
    ["Review", "Read through the plan and note anything you would like moved, added or slowed down."],
    ["Tell us", `Message ${TEAM_NAME} on WhatsApp or email — we re-cut the plan around you, usually the same day.`],
    ["Lock it in", "When it feels right, we help you confirm stays, transfers and experiences for the dates you want."],
  ];

  // No forced page break before this closing block (unlike before "Day by
  // day"): each section is unbreakable on its own, so it follows the last
  // day when there's room and moves to a fresh page when there isn't -
  // never leaving the final day stranded on a near-empty page. "What happens
  // next" and the banner share one unbreakable wrapper so the banner is
  // never orphaned alone on the last page.
  const dot = `<span class="dot">·</span>`;
  return `
  ${tips}
  <div class="section">
    <h2>What happens next</h2>
    <div class="steps">${steps
      .map(
        ([title, text], i) =>
          `<div class="step"><div class="step-num">${String(i + 1).padStart(2, "0")}</div><div class="step-title">${esc(title)}</div><div class="step-text">${esc(text)}</div></div>`
      )
      .join("")}</div>
  <div class="banner">
    <div class="eyebrow">Ready when you are</div>
    <div class="banner-line">Say the word and we will turn this plan into your <em>${esc(model.destination)}</em> trip.</div>
    <div class="banner-contact">${esc(TEAM_NAME)} · <a href="${TEAM_WHATSAPP_URL}">${esc(TEAM_WHATSAPP_DISPLAY)}</a> · <a href="mailto:${TEAM_EMAIL}">${esc(TEAM_EMAIL)}</a> · <a href="${SITE_URL}">1tripwiser.com</a></div>
    <div class="banner-links">
      <span><a class="cta" href="${SIGNUP_URL}">Sign up free</a>${dot}<a href="${BLOG_URL}">Read the blog</a>${dot}<a href="${TRIBE_URL}">Join the Tribe</a></span>
      <span>${SOCIAL_LINKS.map(([label, url]) => `<a href="${url}">${label}</a>`).join(dot)}</span>
    </div>
  </div>
  </div>`;
}

function renderItineraryHtml(trip, itinerary) {
  const model = buildModel(trip, itinerary);
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(model.destination)} itinerary</title>
<style>${allFontsCss()}</style>
<style>${CSS}</style>
</head><body>
  <div class="eyebrow">Your hand-crafted itinerary</div>
  <h1>${model.headline}</h1>
  ${model.summary ? `<p class="lede">${esc(model.summary)}</p>` : ""}
  ${renderFacts(model.facts)}
  ${renderIntroGrid(model)}
  ${renderGlance(model)}

  <div class="page-break" id="days-break"></div>
  <h2>Day by day</h2>
  <p class="sub">Times are indicative. ${esc(TEAM_NAME)} can adjust anything around weather, pace or preference.</p>
  ${model.days.map(renderDay).join("")}

  ${renderClosing(model)}
</body></html>`;
  return { html, model };
}

function headerTemplate(model) {
  return `<style>${chromeFontsCss()}</style>
  <div style="width:100%;padding:0.18in ${MARGIN_INCHES.side}in 0;-webkit-print-color-adjust:exact;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid #e3e6ec;font:500 8.5px/1 'Jost',sans-serif;letter-spacing:0.18em;text-transform:uppercase;color:#8a93a3;">
      <span style="color:#0d1526">1TRIPWISER</span>
      <span>${esc(model.headerRight)}</span>
    </div>
  </div>`;
}

function footerTemplate() {
  return `<style>${chromeFontsCss()}</style>
  <div style="width:100%;padding:0 ${MARGIN_INCHES.side}in 0.18in;-webkit-print-color-adjust:exact;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:1px solid #e3e6ec;font:400 8.5px/1.4 'Jost',sans-serif;color:#8a93a3;">
      <span>Wiser Trips · Better Memories</span>
      <span>${esc(TEAM_EMAIL)} · ${esc(TEAM_WHATSAPP_DISPLAY)} · 1tripwiser.com</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Browser

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const puppeteer = require("puppeteer");
    // --no-sandbox: GitHub's Ubuntu runners block Chrome's user-namespace
    // sandbox. Safe here - the page is our own template with every piece of
    // LLM/sheet text HTML-escaped, and it never navigates anywhere.
    browserPromise = puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) await browser.close();
}

function pdfFileName(destination) {
  return `${String(destination || "trip").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "trip"}-itinerary.pdf`;
}

async function renderItineraryPdf(trip, itinerary) {
  const { html, model } = renderItineraryHtml(trip, itinerary);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Lay the page out at the printed content width so block positions
    // measured below match where Chrome will put them on paper.
    const contentWidthPx = Math.floor((PAPER_INCHES.width - 2 * MARGIN_INCHES.side) * CSS_PX_PER_INCH);
    const contentHeightPx = Math.floor((PAPER_INCHES.height - MARGIN_INCHES.top - MARGIN_INCHES.bottom) * CSS_PX_PER_INCH);
    await page.setViewport({ width: contentWidthPx, height: contentHeightPx });
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluateHandle("document.fonts.ready");

    // The trip-at-a-glance table belongs on page 1. If a long summary or
    // trip pushes it onto page 2 anyway, drop the forced break before
    // "Day by day" so page 2 isn't left almost empty.
    await page.evaluate((limit) => {
      const glance = document.querySelector(".glance");
      const brk = document.getElementById("days-break");
      if (glance && brk && glance.getBoundingClientRect().bottom > limit) brk.classList.remove("page-break");
    }, contentHeightPx);

    const pdf = await page.pdf({
      format: PAPER_FORMAT,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(model),
      footerTemplate: footerTemplate(),
      margin: {
        top: `${MARGIN_INCHES.top}in`,
        bottom: `${MARGIN_INCHES.bottom}in`,
        left: `${MARGIN_INCHES.side}in`,
        right: `${MARGIN_INCHES.side}in`,
      },
    });
    return { buffer: Buffer.from(pdf), fileName: pdfFileName(model.destination) };
  } finally {
    await page.close();
  }
}

module.exports = { renderItineraryPdf, renderItineraryHtml, closeBrowser, parseCalendarDate };
