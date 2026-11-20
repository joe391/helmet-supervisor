/* Helmet supervisor app: pure logic (no DOM). Runs in the browser (window.HelmetLib) and in node (tests).
   Field map, risk codes and status bits come from docs/uplink.md (schema v1). A heat-strain RISK warning, not a diagnosis. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HelmetLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STALE_AFTER_S = 180;      // stage brief: stale warning after 3 minutes
  var GAP_S = 150;              // helmet sends one message per minute: a longer hole is drawn as a gap
  var TEST_STATE = 99;          // docs/uplink.md: test points have field3 = 99 and -99 in the measurements
  var TEST_VALUE = -99;

  // docs/uplink.md section 3 (colours: docs/led_legend.md)
  var STATES = {
    0: { key: "green",  label: "Green",          text: "No heat-strain risk warning" },
    1: { key: "yellow", label: "Yellow",         text: "Raised heat-strain risk" },
    2: { key: "red",    label: "Red",            text: "Heat-strain risk warning (model or fallback rule); buzzer sounds on the helmet" },
    3: { key: "fault",  label: "Fault",          text: "A needed sensor is down, or no risk output (purple on the helmet)" },
    4: { key: "notcal", label: "Not calibrated", text: "No valid baseline: fallback rule only (blue on the helmet)" }
  };

  // docs/uplink.md section 2
  var FLAGS = [
    { bit: 1,   name: "ppg_down",         text: "Heart-rate sensor (MAX30102) failed" },
    { bit: 2,   name: "imu_down",         text: "Motion sensor (MPU-6050) failed" },
    { bit: 4,   name: "dht_down",         text: "Ambient sensor (DHT11) failed; old values repeated" },
    { bit: 8,   name: "mlx_down",         text: "Skin-side IR sensor (MLX90614) failed (log only)" },
    { bit: 16,  name: "fast_fault",       text: "Fast fault: a needed sensor is down" },
    { bit: 32,  name: "fallback_rule",    text: "Fallback rule active (no recent heart rate, or not calibrated)" },
    { bit: 64,  name: "state_reloaded",   text: "Helmet restarted and continued the shift" },
    { bit: 128, name: "uplink_backlog",   text: "Backlog: older messages were still waiting, or the last send failed" },
    { bit: 256, name: "clock_not_synced", text: "Helmet clock was not synchronised: times may be wrong" }
  ];

  var FIELD_OF = { ct: "field1", psi: "field2", state: "field3", hr: "field4", amb: "field5", rh: "field6", pred: "field7", flags: "field8" };

  function numOrNull(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === "string" && x.trim() === "") return null;
    if (typeof x !== "number" && typeof x !== "string") return null;
    var n = Number(x);
    return isFinite(n) ? n : null;
  }

  function parseTime(s) {
    if (typeof s !== "string") return null;
    var t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  function decodeFlags(v) {
    if (v === null || v === undefined) return { valid: true, words: [], unknown: [] };
    if (typeof v !== "number" || !isFinite(v) || v < 0 || Math.floor(v) !== v) return { valid: false, words: [], unknown: [] };
    var words = [], unknown = [], known = 0, i;
    for (i = 0; i < FLAGS.length; i++) {
      known |= FLAGS[i].bit;
      if (v & FLAGS[i].bit) words.push({ bit: FLAGS[i].bit, name: FLAGS[i].name, text: FLAGS[i].text });
    }
    var rest = v - (v & known);
    for (var b = 1; b <= 1 << 20 && rest > 0; b <<= 1) if (rest & b) unknown.push(b);
    return { valid: true, words: words, unknown: unknown };
  }

  // "schema v1; real" -> {schema:"v1", source:"real"}
  function parseStatus(s) {
    var out = { schema: null, source: "unknown" };
    if (typeof s !== "string") return out;
    var m = /schema\s+([A-Za-z0-9._-]+)/.exec(s);
    if (m) out.schema = m[1];
    var r = /;\s*(real|sim|test)\s*$/.exec(s.trim());
    if (r) out.source = r[1];
    return out;
  }

  // One ThingSpeak feed entry -> clean entry, or null when it cannot be used (no valid time).
  function parseEntry(e) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    var t = parseTime(e.created_at);
    if (t === null) return null;
    var st = parseStatus(e.status);
    var ent = {
      t: t,
      created_at: e.created_at,
      ct: numOrNull(e.field1), psi: numOrNull(e.field2), state: numOrNull(e.field3), hr: numOrNull(e.field4),
      amb: numOrNull(e.field5), rh: numOrNull(e.field6), pred: numOrNull(e.field7), flagsRaw: numOrNull(e.field8),
      source: st.source, schema: st.schema, statusText: typeof e.status === "string" ? e.status : ""
    };
    if (ent.state !== null && (Math.floor(ent.state) !== ent.state)) ent.state = null;
    ent.flags = decodeFlags(ent.flagsRaw);
    ent.isTest = ent.state === TEST_STATE || ent.ct === TEST_VALUE || ent.psi === TEST_VALUE || ent.hr === TEST_VALUE ||
                 ent.amb === TEST_VALUE || ent.rh === TEST_VALUE || ent.source === "test";
    return ent;
  }

  // feeds.json body (object) -> {entries sorted by time, skipped}. Throws on a body that is not a feed at all.
  function parseFeed(body) {
    if (!body || typeof body !== "object" || !Array.isArray(body.feeds)) throw new Error("not a ThingSpeak feed");
    var entries = [], skipped = 0, seen = {};
    body.feeds.forEach(function (raw) {
      var e = parseEntry(raw);
      if (!e) { skipped++; return; }
      if (seen[e.t]) { skipped++; return; }
      seen[e.t] = true;
      entries.push(e);
    });
    entries.sort(function (a, b) { return a.t - b.t; });
    return { entries: entries, skipped: skipped, channelName: body.channel && typeof body.channel.name === "string" ? body.channel.name : "" };
  }

  // The "Now" view model.
  function buildModel(feed, nowMs) {
    var m = { kind: "nodata", skipped: feed.skipped, total: feed.entries.length };
    if (!feed.entries.length) return m;
    var latest = feed.entries[feed.entries.length - 1];
    var age = Math.max(0, Math.round((nowMs - latest.t) / 1000));
    var stateInfo = null, stateLabel;
    if (latest.isTest) stateLabel = "Test point";
    else if (latest.state === null) stateLabel = "No state in this entry";
    else if (STATES[latest.state]) stateInfo = STATES[latest.state], stateLabel = stateInfo.label;
    else stateLabel = "Unknown state (" + latest.state + ")";
    m.kind = "ok";
    m.latest = latest;
    m.ageS = age;
    m.stale = age > STALE_AFTER_S;
    m.isTest = latest.isTest;
    m.source = latest.source;
    m.stateKey = latest.isTest ? "test" : stateInfo ? stateInfo.key : "unknown";
    m.stateLabel = stateLabel;
    m.stateText = latest.isTest ? "This is a test message, not a worker's data" : stateInfo ? stateInfo.text : "";
    m.flags = latest.flags;
    m.schemaWarning = latest.schema !== null && latest.schema !== "v1" ? "Schema " + latest.schema + " is not v1: values may mean something else" : "";
    return m;
  }

  function formatAge(s) {
    if (s < 0 || !isFinite(s)) s = 0;
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min " + (s % 60) + " s";
    var h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60);
    if (h < 48) return h + " h " + mi + " min";
    return Math.floor(h / 24) + " d " + (h % 24) + " h";
  }

  function fmt(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return "–";
    return Number(v).toFixed(digits);
  }

  function timeLabel(ms, tz, withSeconds) {
    var o = { hour: "2-digit", minute: "2-digit", hour12: false };
    if (withSeconds) o.second = "2-digit";
    if (tz) o.timeZone = tz;
    return new Date(ms).toLocaleTimeString("en-GB", o);
  }

  // Points for the trend: same source as the newest entry, no test points, last `minutes` before the newest entry.
  function trendPoints(feed, minutes) {
    var n = feed.entries.length;
    if (!n) return { points: [], t0: 0, t1: 0, source: "unknown" };
    var latest = feed.entries[n - 1];
    var t1 = latest.t, t0 = t1 - (minutes || 60) * 60000;
    var pts = feed.entries.filter(function (e) { return !e.isTest && e.source === latest.source && e.t >= t0 && e.t <= t1; });
    return { points: pts, t0: t0, t1: t1, source: latest.source };
  }

  function lastRows(feed, count) {
    var t = trendPoints(feed, 24 * 60).points;   // same source, no test points
    return t.slice(-(count || 20)).reverse();
  }

  // Hand-drawn SVG chart (string). key = "ct" | "hr" | "psi". Colour band = risk state, from entries even when the value is empty.
  function chartSvg(tp, key, opt) {
    opt = opt || {};
    var W = 320, H = 168, L = 36, R = 8, T = 8, plotB = 128, bandY = 134, bandH = 8, tz = opt.tz;
    var minSpan = { ct: 0.6, hr: 20, psi: 2 }[key] || 1;
    var unit = { ct: "°C", hr: "bpm", psi: "" }[key] || "";
    var digits = { ct: 1, hr: 0, psi: 1 }[key];
    var title = opt.title || key;
    var span = tp.t1 - tp.t0 || 1;
    function X(t) { return L + (t - tp.t0) / span * (W - L - R); }
    var vals = tp.points.map(function (p) { return p[key]; }).filter(function (v) { return v !== null; });
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + title + ', last 60 minutes" class="chart">';
    // band
    tp.points.forEach(function (p, i) {
      var next = tp.points[i + 1];
      var end = next ? Math.min(next.t, p.t + GAP_S * 1000) : Math.min(tp.t1 + 60000, p.t + 60000);
      end = Math.min(end, tp.t1 + 60000);
      var cls = STATES[p.state] ? STATES[p.state].key : "unknown";
      var x0 = X(p.t), x1 = Math.min(X(end), W - R);
      if (x1 - x0 < 1) x1 = x0 + 1;
      svg += '<rect class="band b-' + cls + '" x="' + x0.toFixed(1) + '" y="' + bandY + '" width="' + (x1 - x0).toFixed(1) + '" height="' + bandH + '"/>';
    });
    if (!vals.length) {
      svg += '<text class="nodata" x="' + (W / 2) + '" y="' + (plotB / 2) + '" text-anchor="middle">no values in the last 60 min</text>';
    } else {
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      if (hi - lo < minSpan) { var mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
      var pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
      var Y = function (v) { return T + (hi - v) / (hi - lo) * (plotB - T); };
      [lo + pad, (lo + hi) / 2, hi - pad].forEach(function (g) {
        svg += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(g).toFixed(1) + '" y2="' + Y(g).toFixed(1) + '"/>';
        svg += '<text class="ylab" x="' + (L - 4) + '" y="' + (Y(g) + 3).toFixed(1) + '" text-anchor="end">' + g.toFixed(digits) + "</text>";
      });
      var path = "", prevT = null, dots = "";
      tp.points.forEach(function (p) {
        if (p[key] === null) { prevT = null; return; }
        var cmd = prevT === null || p.t - prevT > GAP_S * 1000 ? "M" : "L";
        path += cmd + X(p.t).toFixed(1) + " " + Y(p[key]).toFixed(1);
        prevT = p.t;
        dots = '<circle class="dot" cx="' + X(p.t).toFixed(1) + '" cy="' + Y(p[key]).toFixed(1) + '" r="2.5"/>';
      });
      svg += '<path class="line" d="' + path + '"/>' + dots;
    }
    // x axis labels: 60, 40, 20 min before the newest point, and the newest point
    [0, 20, 40, 60].forEach(function (k) {
      var t = tp.t1 - (60 - k) * 60000;
      var anchor = k === 0 ? "start" : k === 60 ? "end" : "middle";
      svg += '<text class="xlab" x="' + X(t).toFixed(1) + '" y="' + (bandY + bandH + 14) + '" text-anchor="' + anchor + '">' + timeLabel(t, tz) + "</text>";
    });
    svg += '<text class="ytitle" x="' + L + '" y="' + (T + 2) + '" dy="-0.2em">' + (unit ? unit : "") + "</text>";
    return svg + "</svg>";
  }

  // ---- reading ThingSpeak ----
  function buildUrl(cfg, results) {
    var id = String(cfg && cfg.channelId !== undefined ? cfg.channelId : "").trim();
    if (!/^\d{1,12}$/.test(id)) throw new Error("config.js: channelId must be a number");
    var url = "https://api.thingspeak.com/channels/" + id + "/feeds.json?results=" + (results || 120) + "&status=true";
    var key = cfg.readKey;
    if (typeof key === "string" && key.trim() !== "") url += "&api_key=" + encodeURIComponent(key.trim());
    return url;
  }

  // Poller: fetch -> parse -> keep last good body in storage. fetchFn, storage and clock are injected (tests).
  function createPoller(o) {
    var STORE = "helmet.lastFeed";
    function save(body, at) { try { o.storage && o.storage.setItem(STORE, JSON.stringify({ at: at, body: body })); } catch (e) { /* storage may be blocked */ } }
    function load() {
      try {
        var raw = o.storage && o.storage.getItem(STORE);
        if (!raw) return null;
        var j = JSON.parse(raw);
        parseFeed(j.body);
        return j;
      } catch (e) { return null; }
    }
    function fail(reason) {
      var c = load();
      var r = { status: "offline", reason: reason, feed: null, fetchedAt: null };
      if (c) { r.feed = parseFeed(c.body); r.fetchedAt = c.at; }
      return r;
    }
    return {
      poll: function () {
        var url;
        try { url = buildUrl(o.config, o.results); } catch (e) { return Promise.resolve(fail(e.message)); }
        return Promise.resolve().then(function () { return o.fetchFn(url); }).then(function (resp) {
          if (!resp || !resp.ok) throw new Error("HTTP " + (resp ? resp.status : "?"));
          return resp.json();
        }).then(function (body) {
          var feed = parseFeed(body);
          var at = o.now();
          save(body, at);
          return { status: "live", reason: "", feed: feed, fetchedAt: at };
        }).catch(function (e) { return fail(e && e.message ? e.message : "network error"); });
      },
      cached: function () { var c = load(); return c ? { feed: parseFeed(c.body), fetchedAt: c.at } : null; }
    };
  }

  return {
    STALE_AFTER_S: STALE_AFTER_S, STATES: STATES, FLAGS: FLAGS, FIELD_OF: FIELD_OF,
    numOrNull: numOrNull, parseTime: parseTime, decodeFlags: decodeFlags, parseStatus: parseStatus,
    parseEntry: parseEntry, parseFeed: parseFeed, buildModel: buildModel, formatAge: formatAge, fmt: fmt,
    timeLabel: timeLabel, trendPoints: trendPoints, lastRows: lastRows, chartSvg: chartSvg,
    buildUrl: buildUrl, createPoller: createPoller
  };
});
