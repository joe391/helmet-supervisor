/* Supervisor app: DOM glue. All logic is in lib.js (tested with node). Text is always set with textContent. */
(function () {
  "use strict";
  var L = window.HelmetLib, cfg = window.HELMET_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var state = { feed: null, status: "none", reason: "", fetchedAt: null };
  var storage = null;
  try { storage = window.localStorage; } catch (e) { storage = null; }

  var poller = L.createPoller({
    config: cfg, results: cfg.results || 120, storage: storage,
    now: function () { return Date.now(); },
    fetchFn: function (url) {
      var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, 10000) : null;
      return fetch(url, { cache: "no-store", signal: ctl ? ctl.signal : undefined }).then(function (r) { if (timer) clearTimeout(timer); return r; },
        function (e) { if (timer) clearTimeout(timer); throw e; });
    }
  });

  // ---- screens ----
  function show(name) {
    ["now", "trend", "about"].forEach(function (n) {
      $("screen-" + n).hidden = n !== name;
      var t = $("tab-" + n);
      if (n === name) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
  }
  function route() { var h = (location.hash || "#now").slice(1); show(["now", "trend", "about"].indexOf(h) >= 0 ? h : "now"); }
  window.addEventListener("hashchange", route);

  function setVal(id, text, unit) {
    var el = $(id);
    el.textContent = text;
    if (unit && text !== "–") { var s = document.createElement("small"); s.textContent = " " + unit; el.appendChild(s); }
  }

  function render() {
    var now = Date.now();
    var off = $("offline");
    if (state.status === "offline") {
      var when = state.feed && state.feed.entries.length ? L.timeLabel(state.feed.entries[state.feed.entries.length - 1].t, undefined, true) : null;
      off.textContent = "Offline or ThingSpeak unreachable (" + state.reason + "). " +
        (when ? "Showing the last data, from " + when + "." : "No earlier data is saved on this device.");
      off.hidden = false;
    } else off.hidden = true;

    var feed = state.feed;
    var model = feed ? L.buildModel(feed, now) : { kind: "nodata" };
    var tile = $("tile"), badge = $("srcBadge");

    if (model.kind !== "ok") {
      tile.className = "tile s-none";
      $("tileLabel").textContent = feed ? "No data yet" : (state.status === "offline" ? "No data" : "Loading...");
      $("tileText").textContent = feed ? "The channel has no messages. Is the helmet running and sending?" :
        (state.status === "offline" ? "Cannot reach ThingSpeak and nothing is saved on this device." : "Asking ThingSpeak...");
      $("updated").textContent = "Last update: –";
      $("stale").hidden = true; badge.hidden = true; $("testNote").hidden = true;
      ["ct", "psi", "hr", "pred", "amb", "rh"].forEach(function (k) { setVal("v-" + k, "–"); });
      $("flags").textContent = ""; $("schemaWarn").hidden = true;
      renderSkipped(feed);
      renderTrend(feed);
      return;
    }
    var e = model.latest;
    tile.className = "tile s-" + model.stateKey + (model.stale ? " stale" : "");
    $("tileLabel").textContent = model.stateLabel;
    $("tileText").textContent = model.stateText;
    $("updated").textContent = "Last update: " + L.formatAge(model.ageS) + " ago (" + L.timeLabel(e.t, undefined, true) + ")";
    var st = $("stale");
    if (model.stale) { st.textContent = "Stale data: nothing received for " + L.formatAge(model.ageS) + ". The colour above may be out of date."; st.hidden = false; }
    else st.hidden = true;

    badge.hidden = false;
    badge.className = "badge " + model.source;
    badge.textContent = model.source === "unknown" ? "unknown source" : model.source === "sim" ? "SIMULATED" : model.source;
    $("testNote").hidden = !model.isTest;

    setVal("v-ct", L.fmt(e.ct, 1), "°C");
    setVal("v-psi", L.fmt(e.psi, 1));
    setVal("v-hr", L.fmt(e.hr, 0), "bpm");
    setVal("v-pred", L.fmt(e.pred, 2));
    setVal("v-amb", L.fmt(e.amb, 1), "°C");
    setVal("v-rh", L.fmt(e.rh, 0), "%");

    var ul = $("flags"); ul.textContent = "";
    function li(text, cls) { var x = document.createElement("li"); x.textContent = text; if (cls) x.className = cls; ul.appendChild(x); }
    if (!e.flags.valid) li("Status flags unreadable (field8 = " + e.flagsRaw + ")");
    else if (!e.flags.words.length && !e.flags.unknown.length) li("No special status", "ok");
    e.flags.words.forEach(function (w) { li(w.text + " (bit " + w.bit + ")"); });
    e.flags.unknown.forEach(function (b) { li("Unknown status bit " + b); });
    var sw = $("schemaWarn"); sw.textContent = model.schemaWarning; sw.hidden = !model.schemaWarning;
    renderSkipped(feed);
    renderTrend(feed);
  }

  function renderSkipped(feed) {
    var s = $("skipped");
    s.hidden = !(feed && feed.skipped > 0);
    if (!s.hidden) s.textContent = feed.skipped + " entr" + (feed.skipped === 1 ? "y" : "ies") + " could not be read and " + (feed.skipped === 1 ? "was" : "were") + " ignored.";
  }

  function renderTrend(feed) {
    var info = $("trendInfo");
    if (!feed || !feed.entries.length) {
      info.textContent = "No data to draw.";
      ["ct", "hr", "psi"].forEach(function (k) { $("chart-" + k).textContent = ""; });
      $("table").tBodies[0].textContent = "";
      return;
    }
    var tp = L.trendPoints(feed, 60);
    info.textContent = "Last 60 minutes before the newest point (" + L.timeLabel(tp.t1, undefined, true) + "), source: " + tp.source +
      ". Test points are left out. Times are in your local time.";
    var titles = { ct: "Estimated core temperature", hr: "Heart rate", psi: "PSI" };
    ["ct", "hr", "psi"].forEach(function (k) { $("chart-" + k).innerHTML = L.chartSvg(tp, k, { title: titles[k] }); });  // numbers + fixed text only
    var body = $("table").tBodies[0]; body.textContent = "";
    L.lastRows(feed, 20).forEach(function (r) {
      var tr = document.createElement("tr");
      var info = L.STATES[r.state];
      var cells = [L.timeLabel(r.t, undefined, true), null, L.fmt(r.ct, 1), L.fmt(r.hr, 0), L.fmt(r.psi, 1), L.fmt(r.amb, 1), L.fmt(r.rh, 0)];
      cells.forEach(function (c, i) {
        var td = document.createElement("td");
        if (i === 1) {
          var sw = document.createElement("i"); sw.className = "sw b-" + (info ? info.key : "unknown"); td.appendChild(sw);
          td.appendChild(document.createTextNode(info ? info.label : "?"));
        } else td.textContent = c;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  // ---- polling ----
  var busy = false;
  function poll() {
    if (busy) return;
    busy = true;
    poller.poll().then(function (r) {
      state.status = r.status; state.reason = r.reason; state.fetchedAt = r.fetchedAt;
      if (r.feed) state.feed = r.feed;
      render();
    }).then(function () { busy = false; }, function () { busy = false; });
  }

  $("chanId").textContent = String(cfg.channelId);
  var cached = poller.cached();            // show the last data at once while the first poll runs
  if (cached) { state.feed = cached.feed; state.fetchedAt = cached.fetchedAt; }
  route(); render(); poll();
  setInterval(poll, Math.max(15, cfg.pollSeconds || 15) * 1000);
  setInterval(function () { if (state.feed) render(); }, 1000);   // keeps "N s ago" and the stale warning moving between polls
  window.addEventListener("online", poll);
  window.addEventListener("offline", function () { state.status = "offline"; state.reason = "no network"; render(); });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* app still works without it */ });
  }
})();
