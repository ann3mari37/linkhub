/* =====================================================================
   LinkHub - client
   Vanilla JS, no dependencies.
   ===================================================================== */
(function () {
  "use strict";

  var DELETE_WORD = (window.LH_DELETE_WORD || "yes").toLowerCase();

  var state = {
    profiles: [], profileId: 0, sections: [], links: [], filter: "",
    view: pref("lh_view", "grid"),                       /* grid | list */
    showUnsorted: pref("lh_unsorted", "1") !== "0"
  };

  /* Which profile this DEVICE last used. Remembered so you land on your own
     page without picking every time, while still being switchable. */
  var PROFILE_KEY = "lh_profile";
  var VIEW_KEY = "lh_view", UNSORTED_KEY = "lh_unsorted";
  var RECENT_KEY = "lh_recent", RECENT_MAX = 15;

  /* Recently used lives on THIS device only. It is a convenience shortcut,
     not shared state - what you opened is nobody else's business, and it
     should not follow you onto a machine you have never used. */
  function recentIds() {
    try {
      var raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      return Object.prototype.toString.call(raw) === "[object Array]" ? raw : [];
    } catch (e) { return []; }
  }
  function saveRecents(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (e) {}
  }
  function pushRecent(id) {
    var list = recentIds().filter(function (x) { return x !== id; });
    list.unshift(id);
    saveRecents(list);
  }
  function removeRecent(id) {
    saveRecents(recentIds().filter(function (x) { return x !== id; }));
    render();
  }
  function clearRecents() {
    saveRecents([]);
    render();
  }

  function pref(key, dflt) {
    try { var v = localStorage.getItem(key); return v === null ? dflt : v; } catch (e) { return dflt; }
  }
  function setPref(key, val) { try { localStorage.setItem(key, String(val)); } catch (e) {} }
  function rememberedProfile() {
    try { return parseInt(localStorage.getItem(PROFILE_KEY) || "0", 10) || 0; } catch (e) { return 0; }
  }
  function rememberProfile(id) {
    try { localStorage.setItem(PROFILE_KEY, String(id)); } catch (e) {}
  }

  var board     = document.getElementById("board");
  var modalHost = document.getElementById("modalHost");
  var toastHost = document.getElementById("toasts");

  /* ---------------- small helpers ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function el(html) {
    var d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstElementChild;
  }

  function toast(msg, kind) {
    var t = el('<div class="toast ' + (kind || "ok") + '"><span class="dot"></span>' + esc(msg) + "</div>");
    toastHost.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .3s";
      t.style.opacity = "0";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 3200);
  }

  /* fetch() has no built-in timeout: if the server stalls the request sits
     "pending" forever and no .then()/.catch() ever fires, so the spinner never
     clears. An AbortController turns that into a catchable error. Matches the
     approach in War Room's js/utils.js. */
  var API_TIMEOUT_MS = 45000;

  function fetchWithTimeout(url, opts, timeoutMs) {
    opts = opts || {};
    var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timedOut = false, timer = null;
    if (controller) {
      opts.signal = controller.signal;
      timer = setTimeout(function () { timedOut = true; controller.abort(); }, timeoutMs || API_TIMEOUT_MS);
    }
    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      /* signed out (session expired or password changed) - back to the sign-in page */
      if (res.status === 401) location.href = "login.html";
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        throw new Error("The server did not respond within " + ((timeoutMs || API_TIMEOUT_MS) / 1000) +
                        " seconds. Check that the app and its Postgres database are running on Railway.");
      }
      throw err;
    });
  }

  /* POST to api/save as urlencoded form data */
  function api(action, params) {
    var body = "action=" + encodeURIComponent(action) +
               "&profileId=" + encodeURIComponent(state.profileId || 0);
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k)) {
        body += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(params[k] == null ? "" : params[k]);
      }
    }
    return fetchWithTimeout("api/save", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: body,
      cache: "no-store"
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j;
        try { j = JSON.parse(txt); }
        catch (e) { throw new Error("The server returned an unexpected response:\n\n" + txt.slice(0, 600)); }
        if (!j.ok) throw new Error(j.error || "Something went wrong.");
        return j;
      });
    });
  }

  function load() {
    var want = state.profileId || rememberedProfile();
    return fetchWithTimeout("api/data?profileId=" + encodeURIComponent(want), { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        var j;
        try { j = JSON.parse(txt); }
        catch (e) { throw new Error(txt.slice(0, 900)); }
        if (!j.ok) throw new Error(j.error || "Could not load data.");
        state.profiles  = j.profiles || [];
        state.profileId = j.profileId || 0;
        state.sections  = j.sections || [];
        state.links     = j.links || [];
        if (state.profileId) rememberProfile(state.profileId);
        renderProfileChip();
        render();
      })
      .catch(function (e) {
        board.innerHTML =
          '<div class="state error"><h2>Could not load your links</h2>' +
          '<div>Open <a href="healthz">healthz</a> to check the database connection, ' +
          "and look at the service logs on Railway for the full error.</div>" +
          "<pre>" + esc(e.message) + "</pre></div>";
      });
  }

  /* ---------------- presentation helpers ---------------- */

  function hostOf(url) {
    var u = String(url || "");
    if (u.indexOf("\\\\") === 0) return u.split("\\")[2] || "network share";
    try { return new URL(u).host; } catch (e) { return u.replace(/^[a-z]+:\/\//i, "").split("/")[0]; }
  }

  function initialsOf(title) {
    var parts = String(title || "?").trim().split(/[\s\-_.]+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  /* deterministic pleasant color derived from the title */
  function hueOf(title) {
    var h = 0, s = String(title || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function initialsHtml(title, fontSize) {
    var h = hueOf(title);
    return '<span class="thumb-initials"' +
           (fontSize ? ' style="font-size:' + fontSize + ';' : ' style="') +
           "background:linear-gradient(140deg,hsl(" + h + ',52%,42%),hsl(' +
           ((h + 40) % 360) + ',52%,32%))">' + esc(initialsOf(title)) + "</span>";
  }

  /* Lettered tile is what renders first, every time. An image only ever
     replaces it once it has actually loaded, so a missing or broken icon
     can never leave an empty gray square. */
  function thumbHtml(link) { return initialsHtml(link.title); }

  /* ---- automatic favicons ----
     Resolved in the browser straight from the target host, so this works on an
     internal network with no outside calls and no third-party icon service.
     Results (including failures) are cached for a week to avoid re-probing. */

  /* ---- icon resolution ----
     Guessing /favicon.ico from the browser only works for sites that put one
     there. Plenty declare their icon in HTML instead, at a path nothing could
     guess, and the browser cannot read another origin's HTML to find out -
     CORS forbids it. So the SERVER resolves it: api/icon fetches the page,
     reads its <link rel="icon">, follows redirects to the canonical host, and
     writes the answer to links.thumb_url. After that the icon arrives with the
     normal data payload and none of this runs again. */

  /* Bump FAV_VERSION whenever the resolution logic changes. Entries written by
     an older version are ignored, so a fix is never masked by a stale "this
     host has no icon" answer cached before the fix existed. */
  var FAV_VERSION  = 11;  /* bumped: icons embedded in the page (data: URIs) are now found */
  var FAV_TTL_HIT  = 7 * 24 * 60 * 60 * 1000;   /* a found icon rarely moves */
  var FAV_TTL_MISS = 6 * 60 * 60 * 1000;        /* a miss is worth retrying sooner */
  var FAV = {};
  try { FAV = JSON.parse(localStorage.getItem("lh_favicons") || "{}"); } catch (e) { FAV = {}; }
  function favSave() { try { localStorage.setItem("lh_favicons", JSON.stringify(FAV)); } catch (e) {} }

  function favFresh(hit) {
    if (!hit || hit.v !== FAV_VERSION) return false;
    return (Date.now() - hit.t) < (hit.u ? FAV_TTL_HIT : FAV_TTL_MISS);
  }

  function loadImage(src, timeoutMs) {
    return new Promise(function (resolve) {
      var img = new Image(), settled = false;
      var timer = setTimeout(function () { if (!settled) { settled = true; img.src = ""; resolve(null); } }, timeoutMs || 5000);
      img.onload = function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve(img.naturalWidth > 0 ? img : null);
      };
      img.onerror = function () { if (settled) return; settled = true; clearTimeout(timer); resolve(null); };
      img.src = src;
    });
  }

  /* Each lookup is a server round trip that may fetch a slow remote page, so
     they run a few at a time rather than all at once on first paint. */
  var iconQueue = [], iconActive = 0, ICON_PARALLEL = 3;

  function pumpIconQueue() {
    while (iconActive < ICON_PARALLEL && iconQueue.length) {
      var job = iconQueue.shift();
      iconActive++;
      job().then(function () { iconActive--; pumpIconQueue(); },
                 function () { iconActive--; pumpIconQueue(); });
    }
  }

  /* The address field holds whatever was typed, so "outlook.office.com"
     needs a scheme before it can be resolved. UNC shares have no icon to
     fetch and are excluded outright. */
  function httpUrlOf(raw) {
    var u = String(raw || "").trim();
    if (!u) return "";
    if (u.charAt(0) === "\\") return "";   /* UNC share - nothing to fetch */
    if (!/^[a-z]+:\/\//i.test(u)) u = "https://" + u;
    return /^https?:\/\//i.test(u) ? u : "";
  }

  /* Candidate paths the browser can try itself. This cannot find an icon
     declared in HTML at an unguessable path - only the server can read another
     origin's markup - but it does not need the web server to have outbound
     internet access, which a locked-down box may not. */
  function clientCandidates(u) {
    var out = [], origin, host;
    try {
      var parsed = new URL(u);
      origin = parsed.origin;
      host = parsed.hostname;
    } catch (e) { return out; }

    var origins = [origin];
    /* many sites only answer on the www host, and only its certificate is valid */
    if (host.indexOf("www.") !== 0) origins.push(parsed.protocol + "//www." + host);

    origins.forEach(function (o) {
      out.push(o + "/apple-touch-icon.png",
               o + "/apple-touch-icon-precomposed.png",
               o + "/favicon.svg",
               o + "/favicon.png",
               o + "/favicon.ico");
    });
    return out;
  }

  /* All candidates at once, then take the highest-priority one that loaded.
     Walking them one at a time meant a site with none of these paths - which
     is common - burned a multi-second timeout per candidate before giving up. */
  function tryClientCandidates(u) {
    var list = clientCandidates(u);
    if (!list.length) return Promise.resolve("");
    return Promise.all(list.map(function (c) {
      return loadImage(c, 3000).then(function (img) { return img ? c : ""; });
    })).then(function (found) {
      for (var i = 0; i < found.length; i++) { if (found[i]) return found[i]; }
      return "";
    });
  }

  function askServer(link) {
    return new Promise(function (resolve) {
      iconQueue.push(function () {
        return fetchWithTimeout("api/icon?linkId=" + encodeURIComponent(link.id || 0) +
                                "&url=" + encodeURIComponent(httpUrlOf(link.url)),
                                { cache: "no-store" }, 12000)
          .then(function (r) { return r.text(); })
          .then(function (txt) {
            var j = null;
            try { j = JSON.parse(txt); } catch (e) {}
            resolve((j && j.ok && j.icon) ? j.icon : "");
          })
          .catch(function () { resolve(""); });
      });
      pumpIconQueue();
    });
  }

  /* Both routes run at once.

     The browser can only try well-known paths, but it needs nothing from the
     web server. The server can read the page's HTML and find an icon declared
     at any path, but only if it is reachable and allowed to make outbound
     requests. Racing them means an icon shows up whenever EITHER can find one,
     and neither being broken takes the feature down. The server's answer wins
     when both succeed, because a declared icon beats a guessed one. */
  function resolveIcon(link) {
    var key = httpUrlOf(link.url).toLowerCase();
    if (!key) return Promise.resolve("");

    var hit = FAV[key];
    if (favFresh(hit)) return Promise.resolve(hit.u);

    function remember(icon) {
      FAV[key] = { u: icon, t: Date.now(), v: FAV_VERSION };
      favSave();
      return icon;
    }

    /* Nothing is accepted until it has actually rendered in THIS browser.
       An icon URL that the server found but the browser cannot display is
       worse than none at all: it used to be cached and stop the fallback
       ever running, leaving a lettered tile for a site that had a perfectly
       good icon by another route. */
    return askServer(link)
      .catch(function () { return ""; })
      .then(function (icon) {
        if (!icon) return "";
        return loadImage(icon, 6000).then(function (img) { return img ? icon : ""; });
      })
      .then(function (verified) {
        if (verified) return remember(verified);
        return tryClientCandidates(key).then(remember);
      })
      .catch(function () { return ""; });
  }

  /* The lettered tile renders first, always. An image only ever replaces it
     once it has actually loaded, so a slow or broken icon never leaves a gap. */
  function paintThumb(holder, link, onImage) {
    if (!holder) return;
    function apply(src) {
      loadImage(src, 8000).then(function (img) {
        if (!img || !holder.isConnected) return;
        img.alt = ""; img.loading = "lazy";
        holder.innerHTML = "";
        holder.appendChild(img);
        if (onImage) onImage();
      });
    }
    var explicit = link.thumbData || link.thumbUrl;
    if (explicit) { apply(explicit); return; }
    /* id may be 0 - the editor previews an icon before the link is saved */
    var norm = httpUrlOf(link.url);
    if (!norm) return;
    resolveIcon(link).then(function (u) { if (u) apply(u); });
  }

  /* ---------------- dates on the card ---------------- */

  function parseUtc(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  /* Short and glanceable. Exact timestamps go in the tooltip. */
  function ago(iso) {
    var d = parseUtc(iso);
    if (!d) return "";
    var secs = Math.floor((Date.now() - d.getTime()) / 1000);
    if (secs < 60)    return "just now";
    if (secs < 3600)  return Math.floor(secs / 60) + "m ago";
    if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
    var days = Math.floor(secs / 86400);
    if (days < 7)     return days + "d ago";
    if (days < 31)    return Math.floor(days / 7) + "w ago";
    if (days < 365)   return Math.floor(days / 30) + "mo ago";
    return Math.floor(days / 365) + "y ago";
  }

  function exact(iso) {
    var d = parseUtc(iso);
    return d ? d.toLocaleString() : "not recorded";
  }

  function historyHtml(l) {
    var bits = [];
    if (l.created) bits.push('<span title="Added ' + esc(exact(l.created)) + '">added ' + esc(ago(l.created)) + "</span>");
    if (l.edited && l.edited !== l.created) {
      bits.push('<span title="Last edited ' + esc(exact(l.edited)) + '">edited ' + esc(ago(l.edited)) + "</span>");
    }
    if (l.used) {
      bits.push('<span title="You last opened this ' + esc(exact(l.used)) +
                (l.useCount ? " · " + l.useCount + " time" + (l.useCount === 1 ? "" : "s") : "") +
                '">used ' + esc(ago(l.used)) + "</span>");
    } else {
      bits.push('<span title="You have not opened this yet">never used</span>');
    }
    if (!bits.length) return "";
    return '<div class="tile-meta">' + bits.join('<i>&middot;</i>') + "</div>";
  }

  /* Record the open without delaying it. sendBeacon survives the page
     navigating away, which a normal fetch would not. */
  function recordUse(id) {
    pushRecent(id);
    /* The link opens in a new tab, so this page stays on screen - redraw so
       Recently used reflects the click straight away rather than on next load.
       Deferred a tick so it never competes with the navigation itself. */
    setTimeout(render, 0);
    var body = "action=link.used&profileId=" + encodeURIComponent(state.profileId || 0) +
               "&id=" + encodeURIComponent(id);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("api/save",
          new Blob([body], { type: "application/x-www-form-urlencoded" }));
        return;
      }
    } catch (e) {}
    try {
      fetch("api/save", { method: "POST", keepalive: true,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body });
    } catch (e) {}
  }

  function matches(link) {
    if (!state.filter) return true;
    var f = state.filter;
    return (link.title + " " + link.desc + " " + link.url).toLowerCase().indexOf(f) >= 0;
  }

  /* ---------------- render ---------------- */

  /* Shown when this profile has no sections of its own yet. Deliberately NOT
     an early return - the shared catalog still has to render underneath it,
     because a brand new profile has no sections but plenty of links. */
  function firstSectionPrompt() {
    var box = el(
      '<div class="first-run">' +
        "<h2>Add your first section</h2>" +
        "<p>Sections are how you group links on your own page. Everyone shares the same " +
        "links, but the way you arrange them is yours alone.</p>" +
        '<button class="btn btn-primary" id="fr-add">' +
          '<svg width="14" height="14"><use href="#i-folder"/></svg> Add your first section</button>' +
      "</div>"
    );
    box.querySelector("#fr-add").addEventListener("click", function () { openSectionModal(null); });
    return box;
  }

  function render() {
    /* Anything with no placement of mine lands in a virtual Unsorted section.
       It is not a row in the database - it is simply "everything in the shared
       catalog that I have not filed yet", so a link somebody else adds turns
       up here without writing anything to my page. */
    var bySection = { 0: [] };
    state.sections.forEach(function (s) { bySection[s.id] = []; });
    state.links.forEach(function (l) {
      var key = bySection[l.sectionId] ? l.sectionId : 0;
      bySection[key].push(l);
    });

    /* Recently used sits first: it is the shortcut you reach for, so it should
       be where your eye already is. Built from this device's own list, in the
       order you opened things, and silently skipping anything since deleted. */
    var recentLinks = [];
    if (!state.filter) {
      recentIds().forEach(function (id) {
        var l = state.links.filter(function (x) { return x.id === id; })[0];
        if (l) recentLinks.push(l);
      });
    }

    var ordered = state.sections.slice();
    /* Unsorted is always built, but only shown when you want it. Hiding it does
       not hide the links from anything else - they stay in the catalog and in
       the All links panel. */
    if (bySection[0].length && state.showUnsorted) {
      ordered.push({ id: 0, title: "Unsorted", accent: "#6b7688", virtual: true });
    }

    var anyVisible = false;
    board.innerHTML = "";

    if (!state.sections.length && !state.filter) board.appendChild(firstSectionPrompt());

    if (recentLinks.length) {
      anyVisible = true;
      board.appendChild(sectionEl(
        { id: -1, title: "Recently used", accent: "#c678dd", virtual: true, recent: true },
        recentLinks, recentLinks.length));
    }

    ordered.forEach(function (s) {
      var links = bySection[s.id] || [];
      var shown = links.filter(matches);
      if (state.filter && !shown.length) return;
      anyVisible = true;
      board.appendChild(sectionEl(s, shown, links.length));
    });

    if (state.filter && !anyVisible) {
      board.innerHTML = '<div class="state"><h2>No matches</h2><div>Nothing matches &ldquo;' +
                        esc(state.filter) + "&rdquo;.</div></div>";
    } else if (!anyVisible && !state.sections.length && !state.links.length) {
      board.appendChild(el('<div class="state"><div>No links in the catalog yet. ' +
        "Use <b>Add link</b> to create the first one.</div></div>"));
    }
  }

  function sectionEl(s, shownLinks, totalCount) {
    var accent = s.accent || "#4c8dff";
    var sec = el(
      '<section class="section" data-section="' + s.id + '">' +
        '<div class="section-head">' +
          (s.virtual ? "" :
            '<button class="section-grip" title="Drag to reorder this section" aria-label="Reorder section">' +
              '<svg width="15" height="15"><use href="#i-grip"/></svg></button>') +
          '<span class="section-title">' + esc(s.title) + "</span>" +
          '<span class="section-count">' + totalCount + "</span>" +
          '<span class="section-tools">' +
            (s.recent
              ? '<button class="btn btn-ghost btn-sm" data-act="clear">Clear all</button>'
              : "") +
            (s.virtual ? "" :
              '<button class="btn btn-ghost btn-sm" data-act="add">' +
                '<svg width="13" height="13"><use href="#i-plus"/></svg> Add link</button>' +
              '<button class="icon-btn" data-act="edit" title="Rename section" aria-label="Rename section">' +
                '<svg width="15" height="15"><use href="#i-edit"/></svg></button>' +
              '<button class="icon-btn danger" data-act="del" title="Delete section" aria-label="Delete section">' +
                '<svg width="15" height="15"><use href="#i-trash"/></svg></button>') +
          "</span>" +
        "</div>" +
        '<div class="grid"></div>' +
      "</section>"
    );

    var grid = sec.querySelector(".grid");
    if (!shownLinks.length) {
      grid.appendChild(el('<div class="empty">' + (s.virtual
        ? "Nothing unfiled - every link in the catalog is on your page somewhere."
        : "No links in <strong>" + esc(s.title) + "</strong> yet. Use <strong>Add link</strong> " +
          "to create the first one, or drag one in from another section.") + "</div>"));
    } else {
      shownLinks.forEach(function (l) { grid.appendChild(tileEl(l, { recent: !!s.recent })); });
    }

    sec.style.setProperty("--sec-accent", accent);

    if (s.recent) {
      sec.querySelector('[data-act="clear"]').addEventListener("click", clearRecents);
    }
    if (!s.virtual) {
      sec.querySelector('[data-act="add"]').addEventListener("click", function () { openLinkModal(null, s.id); });
      sec.querySelector('[data-act="edit"]').addEventListener("click", function () { openSectionModal(s); });
      sec.querySelector('[data-act="del"]').addEventListener("click", function () { openDeleteModal("section", s); });
    }

    enableSectionDnd(sec);
    return sec;
  }

  function tileEl(l, opts) {
    opts = opts || {};
    /* the card is a div; the title anchor is stretched over it with ::after,
       so the action buttons are real siblings and not nested inside a link */
    var t = el(
      '<div class="tile" draggable="true" data-link="' + l.id + '">' +
        '<div class="tile-top">' +
          '<span class="thumb">' + thumbHtml(l) + "</span>" +
          "<span>" +
            '<div class="tile-title"><a class="tile-link" draggable="false" href="' + esc(l.url) + '"' +
              (l.newTab ? ' target="_blank" rel="noopener noreferrer"' : "") + ">" + esc(l.title) + "</a></div>" +
            '<div class="tile-host">' + esc(hostOf(l.url)) + "</div>" +
          "</span>" +
        "</div>" +
        '<p class="tile-desc' + (l.desc ? "" : " is-empty") + '">' + esc(l.desc || "") + "</p>" +
        historyHtml(l) +
        '<span class="tile-tools">' +
          '<button class="icon-btn" data-act="edit" title="Edit" aria-label="Edit ' + esc(l.title) + '">' +
            '<svg width="15" height="15"><use href="#i-edit"/></svg></button>' +
          /* Filed in one of my sections: the only sensible action here is to
             take it off my page. Removing it from the shared catalog for
             everybody is a different, heavier thing - that lives in Unsorted. */
          (opts.recent
            /* In Recently used the only meaningful action is "stop showing me
               this". It touches nothing but this device's own shortcut list. */
            ? '<button class="icon-btn" data-act="unrecent" title="Remove from Recently used" ' +
                'aria-label="Remove ' + esc(l.title) + ' from Recently used">' +
                '<svg width="15" height="15"><use href="#i-x"/></svg></button>'
            : l.sectionId
              ? '<button class="icon-btn" data-act="unfile" title="Remove from this section" ' +
                  'aria-label="Remove ' + esc(l.title) + ' from this section">' +
                  '<svg width="15" height="15"><use href="#i-minus"/></svg></button>'
              : '<button class="icon-btn danger" data-act="del" title="Delete from the catalog" ' +
                  'aria-label="Delete ' + esc(l.title) + ' from the catalog">' +
                  '<svg width="15" height="15"><use href="#i-trash"/></svg></button>') +
        "</span>" +
        '<button class="tips-badge' + (l.tips ? "" : " is-empty") + '" data-act="tips" ' +
          (l.tips ? 'title="Sign-in tips"' : 'tabindex="-1" aria-hidden="true"') + ">" +
          '<svg width="13" height="13"><use href="#i-key"/></svg> Sign-in tips</button>' +
      "</div>"
    );

    paintThumb(t.querySelector(".thumb"), l);
    if (opts.recent) {
      t.removeAttribute("draggable");
    } else {
      bindTileDrag(t, l);
    }

    var openLink = t.querySelector(".tile-link");
    if (openLink) openLink.addEventListener("click", function () { recordUse(l.id); });

    t.querySelectorAll("[data-act]").forEach(function (b) {
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var a = b.getAttribute("data-act");
        if (a === "edit") openLinkModal(l, l.sectionId);
        else if (a === "del") openDeleteModal("link", l);
        else if (a === "unfile") unfileLink(l);
        else if (a === "unrecent") removeRecent(l.id);
        else if (a === "tips") { if (l.tips) openTipsModal(l); }
      });
    });

    return t;
  }

  /* ---------------- the catalog dropdown ----------------
     Every link that exists, whether or not it is on your page. Rows drag
     straight into a section, which is the quickest way to build a page from
     links other people have already added. */

  var catalogOpen = false;

  function catalogRowHtml(l) {
    var placed = l.sectionId ? sectionNameFor(l) : "";
    return '<div class="cat-row" draggable="true" data-cat="' + l.id + '" title="Drag into a section">' +
             '<span class="cat-thumb"></span>' +
             '<span class="cat-text">' +
               '<span class="cat-title">' + esc(l.title) + "</span>" +
               '<span class="cat-url">' + esc(l.url) + "</span>" +
             "</span>" +
             (placed ? '<span class="cat-placed" title="Already on your page">' + esc(placed) + "</span>" : "") +
           "</div>";
  }

  function renderCatalog() {
    var panel = document.getElementById("catalogPanel");
    if (!panel) return;
    var links = state.links.slice().sort(function (a, b) {
      return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
    });

    panel.innerHTML =
      '<div class="cat-head">' +
        "<b>All links</b>" +
        '<span class="cat-count">' + links.length + "</span>" +
        '<span class="cat-hint">drag into a section</span>' +
      "</div>" +
      '<div class="cat-list">' +
        (links.length ? links.map(catalogRowHtml).join("")
                      : '<div class="empty" style="margin:12px">No links yet.</div>') +
      "</div>";

    links.forEach(function (l) {
      var row = panel.querySelector('[data-cat="' + l.id + '"]');
      if (!row) return;
      var holder = row.querySelector(".cat-thumb");
      holder.innerHTML = initialsHtml(l.title, "12px");
      paintThumb(holder, l);

      row.addEventListener("dragstart", function (e) {
        dragLinkId = l.id;
        dragEl = null;              /* nothing on the board is moving */
        dragSectionId = null;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "copyMove";
        try { e.dataTransfer.setData("text/plain", String(l.id)); } catch (ex) {}
      });
      row.addEventListener("dragend", function () {
        row.classList.remove("dragging");
        hideDropBar();
        dragLinkId = null;
      });
      /* clicking a row opens the link, same as its tile */
      row.addEventListener("click", function () {
        recordUse(l.id);
        window.open(l.url, "_blank", "noopener");
      });
    });
  }

  function toggleCatalog(force) {
    var panel = document.getElementById("catalogPanel");
    var btn = document.getElementById("btnCatalog");
    if (!panel || !btn) return;
    catalogOpen = (typeof force === "boolean") ? force : !catalogOpen;
    if (catalogOpen) renderCatalog();
    panel.hidden = !catalogOpen;
    btn.setAttribute("aria-expanded", catalogOpen ? "true" : "false");
    btn.classList.toggle("btn-primary", catalogOpen);
  }

  /* Take a link off my page without touching the shared catalog. It drops
     back into Unsorted, where it can be re-filed or deleted outright. */
  function unfileLink(l) {
    var remaining = state.links
      .filter(function (x) { return x.sectionId === l.sectionId && x.id !== l.id; })
      .map(function (x) { return x.id; });

    api("reorder.links", { sectionId: l.sectionId, ids: remaining.join(",") })
      .then(function () {
        return api("reorder.links", { sectionId: 0, ids: String(l.id) });
      })
      .then(function () {
        toast(state.showUnsorted ? "Moved to Unsorted."
                                 : "Moved to Unsorted (currently hidden).");
        return load();
      })
      .catch(function (e) { toast(e.message, "bad"); load(); });
  }

  /* ---------------- view preferences ---------------- */

  function applyView() {
    document.body.classList.toggle("view-list", state.view === "list");
    var g = document.getElementById("btnViewGrid");
    var l = document.getElementById("btnViewList");
    var u = document.getElementById("btnUnsorted");
    if (g) g.classList.toggle("on", state.view === "grid");
    if (l) l.classList.toggle("on", state.view === "list");
    if (u) {
      u.classList.toggle("on", state.showUnsorted);
      u.title = state.showUnsorted ? "Hide Unsorted" : "Show Unsorted";
    }
  }

  function setView(v) {
    state.view = v;
    setPref(VIEW_KEY, v);
    applyView();
  }

  function toggleUnsorted() {
    state.showUnsorted = !state.showUnsorted;
    setPref(UNSORTED_KEY, state.showUnsorted ? "1" : "0");
    applyView();
    render();
  }

  /* ---------------- modal shell ---------------- */

  var openOverlays = [];

  function openModal(innerHtml, opts) {
    opts = opts || {};
    var overlay = el('<div class="overlay" role="dialog" aria-modal="true"></div>');
    overlay.innerHTML = '<div class="modal' + (opts.narrow ? " narrow" : "") + '">' + innerHtml + "</div>";
    modalHost.appendChild(overlay);
    openOverlays.push(overlay);

    function close() {
      var i = openOverlays.indexOf(overlay);
      if (i >= 0) openOverlays.splice(i, 1);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape" && openOverlays[openOverlays.length - 1] === overlay) { e.stopPropagation(); close(); }
    }
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    overlay.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", close); });

    var first = overlay.querySelector("input, textarea, select");
    if (first) setTimeout(function () { first.focus(); first.select && first.select(); }, 40);

    return { overlay: overlay, close: close, el: overlay.querySelector(".modal") };
  }

  function head(title, sub) {
    return '<div class="modal-head"><div style="flex:1"><h2>' + esc(title) + "</h2>" +
           (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") + "</div>" +
           '<button class="icon-btn" data-close aria-label="Close">' +
           '<svg width="16" height="16"><use href="#i-x"/></svg></button></div>';
  }

  function showErr(m, msg) {
    var bar = m.el.querySelector(".errbar");
    bar.textContent = msg;
    bar.classList.add("show");
    bar.scrollIntoView({ block: "nearest" });
  }

  /* ---------------- sign-in tips ---------------- */

  function openTipsModal(l) {
    openModal(
      head("Signing in to " + l.title, "Notes saved with this link") +
      '<div class="modal-body"><div class="tips-body">' + esc(l.tips) + "</div></div>" +
      '<div class="modal-foot"><button class="btn" data-close>Close</button></div>',
      { narrow: true }
    );
  }

  /* ---------------- profiles ---------------- */

  function currentProfile() {
    for (var i = 0; i < state.profiles.length; i++) {
      if (state.profiles[i].id === state.profileId) return state.profiles[i];
    }
    return null;
  }

  function renderProfileChip() {
    var host = document.getElementById("profileChip");
    if (!host) return;
    var p = currentProfile();
    if (!p) {
      host.innerHTML = '<button class="btn btn-primary" id="pickProfile">Choose your profile</button>';
      host.querySelector("#pickProfile").addEventListener("click", openProfileModal);
      return;
    }
    host.innerHTML =
      '<button class="profile-chip" id="pickProfile" title="Switch profile">' +
        '<span class="profile-dot" style="background:' + esc(p.color || "#4c8dff") + '">' +
          esc(initialsOf(p.name)) + "</span>" +
        '<span class="profile-name">' + esc(p.name) + "</span>" +
        '<svg width="12" height="12" style="opacity:.6"><use href="#i-grip"/></svg>' +
      "</button>";
    host.querySelector("#pickProfile").addEventListener("click", openProfileModal);
  }

  function switchProfile(id) {
    state.profileId = id;
    rememberProfile(id);
    state.filter = "";
    var q = document.getElementById("q");
    if (q) q.value = "";
    load();
  }

  var PROFILE_PALETTE = ["#4c8dff", "#38b48b", "#e0a458", "#c678dd", "#ef6f6c", "#4fc3f7"];

  /* Rename or recolour one profile. */
  function openProfileEditModal(p, afterSave) {
    var color = p.color || "#4c8dff";
    var swatches = PROFILE_PALETTE.map(function (c) {
      return '<button type="button" class="icon-btn sw" data-color="' + c + '" title="' + c + '" ' +
             'style="background:' + c + ';width:24px;height:24px;border-radius:50%;' +
             (c.toLowerCase() === color.toLowerCase() ? "box-shadow:0 0 0 3px var(--accent-dim);" : "") + '"></button>';
    }).join("");

    var m = openModal(
      head("Rename profile", p.name) +
      '<div class="modal-body">' +
        '<div class="errbar"></div>' +
        '<div class="field"><label for="pe-name">Name <span class="req">*</span></label>' +
          '<input class="input" id="pe-name" maxlength="100" value="' + esc(p.name) + '"></div>' +
        '<div class="field"><label>Colour</label>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' + swatches + "</div></div>" +
      "</div>" +
      '<div class="modal-foot">' +
        '<button class="btn" data-close>Cancel</button>' +
        '<button class="btn btn-primary" id="pe-save">Save changes</button>' +
      "</div>",
      { narrow: true }
    );

    m.el.querySelectorAll(".sw").forEach(function (b) {
      b.addEventListener("click", function () {
        color = b.getAttribute("data-color");
        m.el.querySelectorAll(".sw").forEach(function (o) { o.style.boxShadow = "none"; });
        b.style.boxShadow = "0 0 0 3px var(--accent-dim)";
      });
    });

    m.el.querySelector("#pe-save").addEventListener("click", function () {
      var btn = this;
      var name = m.el.querySelector("#pe-name").value.trim();
      if (!name) { showErr(m, "Give the profile a name."); return; }
      btn.disabled = true;
      btn.textContent = "Saving...";
      api("profile.save", { id: p.id, name: name, color: color })
        .then(function () {
          m.close();
          toast("Profile updated.");
          return load().then(function () { if (afterSave) afterSave(); });
        })
        .catch(function (e) {
          btn.disabled = false;
          btn.textContent = "Save changes";
          showErr(m, e.message);
        });
    });
  }

  function openProfileModal() {
    var rows = state.profiles.map(function (p) {
      var isMe = p.id === state.profileId;
      return '<div class="profile-row' + (isMe ? " current" : "") + '" data-profile="' + p.id + '">' +
               '<button class="profile-pick" data-act="switch" title="Switch to this profile">' +
                 '<span class="profile-dot" style="background:' + esc(p.color || "#4c8dff") + '">' +
                   esc(initialsOf(p.name)) + "</span>" +
                 '<span class="profile-row-name">' + esc(p.name) + "</span>" +
                 (isMe ? '<span class="profile-tag">you</span>' : "") +
               "</button>" +
               '<span class="profile-acts">' +
                 '<button class="icon-btn" data-act="edit" title="Rename" aria-label="Rename ' + esc(p.name) + '">' +
                   '<svg width="14" height="14"><use href="#i-edit"/></svg></button>' +
                 '<button class="icon-btn danger" data-act="del" title="Delete" aria-label="Delete ' + esc(p.name) + '">' +
                   '<svg width="14" height="14"><use href="#i-trash"/></svg></button>' +
               "</span>" +
             "</div>";
    }).join("");

    var m = openModal(
      head("Profiles", "Everyone shares the same links. Sections and layout are personal.") +
      '<div class="modal-body">' +
        '<div class="errbar"></div>' +
        '<div class="profile-list">' + (rows || '<div class="empty">No profiles yet.</div>') + "</div>" +
        '<div class="field" style="margin-top:16px"><label for="p-name">Add a profile</label>' +
          '<div class="row">' +
            '<input class="input" id="p-name" maxlength="100" placeholder="Name">' +
            '<button class="btn btn-primary" id="p-add" style="flex:0 0 auto">Create</button>' +
          "</div>" +
          '<div class="hint">A new profile starts with no sections &mdash; every link sits in Unsorted until it is filed.</div>' +
        "</div>" +
      "</div>" +
      '<div class="modal-foot"><button class="btn" data-close>Close</button></div>',
      { narrow: true }
    );

    m.el.querySelectorAll(".profile-row").forEach(function (rowEl) {
      var id = parseInt(rowEl.getAttribute("data-profile"), 10);
      var prof = state.profiles.filter(function (x) { return x.id === id; })[0];
      if (!prof) return;

      rowEl.querySelector('[data-act="switch"]').addEventListener("click", function () {
        m.close();
        if (id !== state.profileId) switchProfile(id);
      });
      rowEl.querySelector('[data-act="edit"]').addEventListener("click", function (e) {
        e.stopPropagation();
        m.close();
        openProfileEditModal(prof, function () { openProfileModal(); });
      });
      rowEl.querySelector('[data-act="del"]').addEventListener("click", function (e) {
        e.stopPropagation();
        if (state.profiles.length <= 1) {
          showErr(m, "This is the only profile. Create another one before deleting it.");
          return;
        }
        m.close();
        openDeleteModal("profile", prof);
      });
    });

    m.el.querySelector("#p-add").addEventListener("click", function () {
      var btn = this;
      var name = m.el.querySelector("#p-name").value.trim();
      if (!name) { showErr(m, "Give the profile a name."); return; }
      btn.disabled = true;
      btn.textContent = "Creating...";
      /* profileId is not known yet for a brand new profile, so this one call
         deliberately goes out without one - the server allows that for
         profile.save only */
      api("profile.save", { id: 0, name: name, color: PROFILE_PALETTE[state.profiles.length % PROFILE_PALETTE.length] })
        .then(function (r) {
          m.close();
          toast("Profile created.");
          switchProfile(r.id);
        })
        .catch(function (e) {
          btn.disabled = false;
          btn.textContent = "Create";
          showErr(m, e.message);
        });
    });
  }

  /* ---------------- duplicate detection ----------------
     Links are one shared catalog now, so a duplicate is everyone's
     duplicate. Compared on a canonical form so the obvious variants of the
     same address collapse together: scheme, a leading www., a trailing
     slash, and default ports are all ignored, and the host is lowercased.
     The path IS significant - /hr and /payroll on one host are different
     links - but its case is preserved because some servers care. */

  function canonicalUrl(raw) {
    var u = String(raw || "").trim();
    if (!u) return "";
    if (u.indexOf("\\\\") === 0) return u.toLowerCase().replace(/[\/]+$/, "");
    if (!/^[a-z]+:\/\//i.test(u)) u = "https://" + u;
    var parsed;
    try { parsed = new URL(u); } catch (e) { return u.toLowerCase().replace(/\/+$/, ""); }
    var host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if ((parsed.protocol === "https:" && parsed.port === "443") ||
        (parsed.protocol === "http:"  && parsed.port === "80")) parsed.port = "";
    var path = parsed.pathname.replace(/\/+$/, "");
    return host + (parsed.port ? ":" + parsed.port : "") + path + parsed.search;
  }

  /* The catalog is already loaded, so this costs nothing and can run on
     every keystroke. Returns the existing link, or null. */
  function findDuplicate(url, ignoreId) {
    var key = canonicalUrl(url);
    if (!key) return null;
    for (var i = 0; i < state.links.length; i++) {
      var l = state.links[i];
      if (ignoreId && l.id === ignoreId) continue;
      if (canonicalUrl(l.url) === key) return l;
    }
    return null;
  }

  function sectionNameFor(link) {
    if (!link.sectionId) return "Unsorted";
    for (var i = 0; i < state.sections.length; i++) {
      if (state.sections[i].id === link.sectionId) return state.sections[i].title;
    }
    return "Unsorted";
  }

  /* Scroll a tile into view and flash it, so "go to the existing one" lands
     somewhere obvious rather than just closing the dialog. */
  function revealLink(id) {
    var tile = document.querySelector('.tile[data-link="' + id + '"]');
    if (!tile) return;
    tile.scrollIntoView({ behavior: "smooth", block: "center" });
    tile.classList.add("flash");
    setTimeout(function () { tile.classList.remove("flash"); }, 2200);
  }

  /* ---------------- deriving a name from an address ----------------
     A page title cannot be read across origins, so the name comes from the
     host. Well-known hosts whose brand differs from their domain get a proper
     name; everything else is the domain's main label, cleaned up. */

  var SITE_NAMES = {
    "meta.com": "Meta", "facebook.com": "Facebook", "fb.com": "Facebook",
    "instagram.com": "Instagram", "linkedin.com": "LinkedIn", "x.com": "X",
    "outlook.office.com": "Outlook", "outlook.office365.com": "Outlook",
    "teams.microsoft.com": "Microsoft Teams", "login.microsoftonline.com": "Microsoft 365",
    "office.com": "Microsoft 365", "sharepoint.com": "SharePoint",
    "onedrive.live.com": "OneDrive", "drive.google.com": "Google Drive",
    "mail.google.com": "Gmail", "calendar.google.com": "Google Calendar",
    "docs.google.com": "Google Docs", "youtube.com": "YouTube",
    "quickbooks.intuit.com": "QuickBooks", "intuit.com": "Intuit",
    "github.com": "GitHub", "gitlab.com": "GitLab", "dropbox.com": "Dropbox",
    "slack.com": "Slack", "zoom.us": "Zoom", "docusign.com": "DocuSign",
    "adp.com": "ADP", "paychex.com": "Paychex", "gusto.com": "Gusto",
    "salesforce.com": "Salesforce", "hubspot.com": "HubSpot",
    "indeed.com": "Indeed", "osha.gov": "OSHA", "irs.gov": "IRS",
    "homedepot.com": "The Home Depot", "lowes.com": "Lowe’s",
    "amazon.com": "Amazon", "ups.com": "UPS", "fedex.com": "FedEx"
  };

  /* words that are never the business name */
  var GENERIC_LABELS = { www:1, web:1, app:1, apps:1, portal:1, my:1, secure:1,
                         login:1, signin:1, sso:1, auth:1, intranet:1, home:1,
                         site:1, sites:1, "new":1, go:1, link:1, links:1 };

  function titleCase(word) {
    if (!word) return "";
    if (word.length <= 3 && word === word.toLowerCase() && !/[aeiou]/.test(word)) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function nameFromUrl(raw) {
    var u = String(raw || "").trim();
    if (!u) return "";

    /* UNC share: \fileserver\jobphotos -> Jobphotos, else the server name */
    if (u.indexOf("\\\\") === 0) {
      var seg = u.split("\\").filter(Boolean);
      var pick = seg[1] || seg[0] || "";
      return pick.split(/[-_.]+/).map(titleCase).join(" ");
    }

    var host;
    try { host = new URL(/^[a-z]+:\/\//i.test(u) ? u : "https://" + u).hostname; }
    catch (e) { return ""; }
    host = host.toLowerCase().replace(/^www\./, "");
    if (!host || host.indexOf(".") < 0) return titleCase(host);

    if (SITE_NAMES[host]) return SITE_NAMES[host];

    /* try progressively shorter suffixes, so payroll.adp.com finds adp.com */
    var parts = host.split(".");
    for (var i = 1; i < parts.length - 1; i++) {
      var suffix = parts.slice(i).join(".");
      if (SITE_NAMES[suffix]) return SITE_NAMES[suffix];
    }

    /* Otherwise: the last label is always the TLD, so drop it. Drop a
       second-level suffix too (co.uk, com.au). What remains ends with the
       organization name - walk back past generic subdomains to find it. */
    var SECOND_LEVEL = /^(co|com|org|net|gov|edu|ac|govt|mil)$/;
    parts.pop();
    if (parts.length > 1 && SECOND_LEVEL.test(parts[parts.length - 1])) parts.pop();

    var label = "";
    for (var k = parts.length - 1; k >= 0; k--) {
      if (!GENERIC_LABELS[parts[k]]) { label = parts[k]; break; }
    }
    if (!label) label = parts[parts.length - 1] || "";

    return label.split(/[-_]+/).map(titleCase).join(" ");
  }

  /* ---------------- link editor ---------------- */

  function openLinkModal(link, defaultSectionId) {
    var isNew = !link;
    link = link || { id: 0, title: "", url: "", desc: "", thumbData: "", thumbUrl: "", tips: "", newTab: true };
    /* 0 means Unsorted, and is a perfectly good place for a new link */
    var sectionId = link.sectionId || defaultSectionId || 0;

    var opts = '<option value="0"' + (!sectionId ? " selected" : "") + ">Unsorted</option>" +
      state.sections.map(function (s) {
        return '<option value="' + s.id + '"' + (s.id === sectionId ? " selected" : "") + ">" + esc(s.title) + "</option>";
      }).join("");

    var m = openModal(
      head(isNew ? "Add a link" : "Edit link", isNew ? "It will appear at the end of the section" : link.title) +
      '<div class="modal-body">' +
        '<div class="errbar"></div>' +

        /* the icon leads the form - it is derived, not edited */
        '<div class="lead">' +
          '<span class="thumb-preview" id="f-thumb-prev"></span>' +
          '<span class="lead-text">' +
            '<span class="lead-title" id="f-lead-title">' + esc(link.title || "New link") + "</span>" +
          "</span>" +
          '<span class="lead-acts">' +
            (link.id ? '<button type="button" class="btn btn-sm" id="f-reset-icon" ' +
                       'title="Look the icon up again">Refresh icon</button>' : "") +
          "</span>" +
        "</div>" +
        '<div class="field"><label for="f-url">Web address <span class="req">*</span></label>' +
          '<input class="input" id="f-url" maxlength="1000" value="' + esc(link.url) + '" placeholder="payroll.company.com">' +
          '<div class="dupe" id="f-dupe"></div>' +
          '<div class="hint">https:// is added automatically if you leave it off. ' +
          'UNC paths like \\server\share also work.</div></div>' +
        '<div class="field"><label for="f-title">Name <span class="req">*</span></label>' +
          '<input class="input" id="f-title" maxlength="150" value="' + esc(link.title) + '" placeholder="Filled in from the address">' +
          '<div class="hint">Filled in from the web address, until you type your own.</div></div>' +
        '<div class="row"><div class="field"><label for="f-section">Section</label>' +
          '<select class="select" id="f-section">' + opts + "</select></div></div>" +
        '<div class="field"><label for="f-desc">Short description</label>' +
          '<textarea class="textarea" id="f-desc" maxlength="500" style="min-height:56px" ' +
          'placeholder="Optional - one line about what this is for">' + esc(link.desc) + "</textarea></div>" +
        '<div class="field"><label for="f-tips">Sign-in tips</label>' +
          '<textarea class="textarea" id="f-tips" placeholder="Optional - e.g. Use your network username without the domain. Reset via the IT desk.">' +
          esc(link.tips) + "</textarea>" +
          '<div class="hint">Shown behind a &ldquo;Sign-in tips&rdquo; button on the tile. Never store passwords here.</div></div>' +
      "</div>" +
      '<div class="modal-foot">' +
        '<button class="btn" data-close>Cancel</button>' +
        '<button class="btn btn-primary" id="f-save">' + (isNew ? "Add link" : "Save changes") + "</button>" +
      "</div>"
    );

    var q = function (sel) { return m.el.querySelector(sel); };

    /* true until the user types a name of their own; only then do we stop
       overwriting it from the address */
    var nameIsAuto = isNew || !link.title;

    /* Split deliberately. The icon depends only on the address, so typing in
       any other field must not clear it and send the lookup round again -
       that is what made the icon flicker back to letters on every keystroke. */
    var leadIconUrl = null;    /* the address the current icon was resolved for */
    var leadHasImage = false;  /* an actual image is on screen, not letters */

    function paintLeadText() {
      var title = q("#f-title").value || nameFromUrl(q("#f-url").value) || "?";
      q("#f-lead-title").textContent = title === "?" ? "New link" : title;
      if (!leadHasImage) {
        q("#f-thumb-prev").innerHTML = initialsHtml(title, "22px");
      }
    }

    function paintLeadIcon() {
      var url = q("#f-url").value.trim();
      if (url === leadIconUrl) return;   /* address unchanged - leave it alone */
      leadIconUrl = url;
      leadHasImage = false;
      paintLeadText();
      paintThumb(q("#f-thumb-prev"), {
        thumbData: link.thumbData,
        thumbUrl: link.thumbUrl,
        url: url,
        title: q("#f-title").value
      }, function () { leadHasImage = true; });
    }

    function syncNameFromUrl() {
      if (!nameIsAuto) return;
      var guess = nameFromUrl(q("#f-url").value);
      if (guess) q("#f-title").value = guess;
    }

    q("#f-title").addEventListener("input", function () {
      nameIsAuto = q("#f-title").value.trim() === "";
      paintLeadText();
    });

    var resetBtn = q("#f-reset-icon");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        var btn = this;
        btn.disabled = true;
        btn.textContent = "Resetting...";
        api("link.reseticon", { id: link.id })
          .then(function () {
            /* drop the browser's memory of it too, or the old answer is
               simply handed straight back */
            var k = httpUrlOf(link.url).toLowerCase();
            if (k) { delete FAV[k]; favSave(); }
            link.thumbData = ""; link.thumbUrl = "";
            leadIconUrl = null;
            paintLeadIcon();
            btn.disabled = false;
            btn.textContent = "Reset icon";
            toast("Icon cleared - looking it up again.");
          })
          .catch(function (e) {
            btn.disabled = false;
            btn.textContent = "Reset icon";
            showErr(m, e.message);
          });
      });
    }

    var dupeAcknowledged = false;
    var dupeMatch = null;

    function checkDuplicate() {
      var url = q("#f-url").value.trim();
      dupeMatch = url ? findDuplicate(url, link.id || 0) : null;
      var bar = q("#f-dupe");
      if (!dupeMatch) {
        bar.className = "dupe";
        bar.innerHTML = "";
        return;
      }
      bar.className = "dupe show";
      bar.innerHTML =
        '<div class="dupe-head">Already in the catalog</div>' +
        '<div class="dupe-body"><b>' + esc(dupeMatch.title) + "</b> points at the same address" +
        (link.id ? "" : ", and is on your page under <b>" + esc(sectionNameFor(dupeMatch)) + "</b>") +
        ".</div>" +
        '<div class="dupe-acts">' +
          '<button type="button" class="btn btn-sm" data-dupe="goto">Go to that one</button>' +
          '<button type="button" class="btn btn-sm" data-dupe="anyway">Add anyway</button>' +
        "</div>";
      bar.querySelector('[data-dupe="goto"]').addEventListener("click", function () {
        m.close();
        revealLink(dupeMatch.id);
      });
      bar.querySelector('[data-dupe="anyway"]').addEventListener("click", function () {
        dupeAcknowledged = true;
        bar.className = "dupe show muted";
        bar.innerHTML = '<div class="dupe-body">Duplicate accepted &mdash; this will be added as a second entry.</div>';
      });
    }

    var urlDebounce = null;
    q("#f-url").addEventListener("input", function () {
      syncNameFromUrl();
      dupeAcknowledged = false;
      checkDuplicate();
      paintLeadText();
      clearTimeout(urlDebounce);
      urlDebounce = setTimeout(paintLeadIcon, 550);
    });
    checkDuplicate();
    q("#f-url").addEventListener("blur", function () {
      syncNameFromUrl();
      paintLeadText();
      paintLeadIcon();
    });

    paintLeadText();
    paintLeadIcon();

    q("#f-save").addEventListener("click", function () {
      var btn = this;
      var url = q("#f-url").value.trim();
      var title = q("#f-title").value.trim() || nameFromUrl(url);
      if (!url) { showErr(m, "Give the link a web address."); q("#f-url").focus(); return; }
      if (!title) { showErr(m, "Give the link a name."); q("#f-title").focus(); return; }
      if (dupeMatch && !dupeAcknowledged) {
        showErr(m, "“" + dupeMatch.title + "” already points at this address. " +
                   "Choose “Go to that one” or “Add anyway” above.");
        q("#f-dupe").scrollIntoView({ block: "nearest" });
        return;
      }

      btn.disabled = true;
      btn.textContent = "Saving...";
      api("link.save", {
        id: link.id || 0,
        sectionId: q("#f-section").value,
        title: title,
        url: url,
        desc: q("#f-desc").value.trim(),
        thumbData: link.thumbData || "",
        thumbUrl: link.thumbUrl || "",
        tips: q("#f-tips").value.trim(),
        newTab: "1"
      }).then(function () {
        m.close();
        toast(isNew ? "Link added." : "Link updated.");
        return load();
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = isNew ? "Add link" : "Save changes";
        showErr(m, e.message);
      });
    });
  }

  /* ---------------- section editor ---------------- */

  var PRESETS = ["#4c8dff", "#38b48b", "#e0a458", "#c678dd", "#ef6f6c", "#4fc3f7", "#8d99ab"];

  function openSectionModal(section) {
    var isNew = !section;
    section = section || { id: 0, title: "", accent: PRESETS[state.sections.length % PRESETS.length] };
    var accent = section.accent || "#4c8dff";

    var swatches = PRESETS.map(function (c) {
      return '<button type="button" class="icon-btn sw" data-color="' + c + '" title="' + c + '" ' +
             'style="background:' + c + ';width:24px;height:24px;border-radius:50%;' +
             (c.toLowerCase() === accent.toLowerCase() ? "box-shadow:0 0 0 3px var(--accent-dim);" : "") + '"></button>';
    }).join("");

    var m = openModal(
      head(isNew ? "New section" : "Rename section", isNew ? "Groups links on the landing page" : section.title) +
      '<div class="modal-body">' +
        '<div class="errbar"></div>' +
        '<div class="field"><label for="s-title">Section name <span class="req">*</span></label>' +
          '<input class="input" id="s-title" maxlength="100" value="' + esc(section.title) +
          '" placeholder="Everyday Tools"></div>' +
        '<div class="field"><label>Accent color</label>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' + swatches + "</div></div>" +
      "</div>" +
      '<div class="modal-foot">' +
        '<button class="btn" data-close>Cancel</button>' +
        '<button class="btn btn-primary" id="s-save">' + (isNew ? "Create section" : "Save changes") + "</button>" +
      "</div>",
      { narrow: true }
    );

    m.el.querySelectorAll(".sw").forEach(function (b) {
      b.addEventListener("click", function () {
        accent = b.getAttribute("data-color");
        m.el.querySelectorAll(".sw").forEach(function (o) { o.style.boxShadow = "none"; });
        b.style.boxShadow = "0 0 0 3px var(--accent-dim)";
      });
    });

    m.el.querySelector("#s-save").addEventListener("click", function () {
      var btn = this;
      var title = m.el.querySelector("#s-title").value.trim();
      if (!title) { showErr(m, "Give the section a name."); return; }
      btn.disabled = true;
      btn.textContent = "Saving...";
      api("section.save", { id: section.id || 0, title: title, accent: accent })
        .then(function () {
          m.close();
          toast(isNew ? "Section created." : "Section updated.");
          return load();
        })
        .catch(function (e) {
          btn.disabled = false;
          btn.textContent = isNew ? "Create section" : "Save changes";
          showErr(m, e.message);
        });
    });
  }

  /* ---------------- delete: two steps, then type the word ---------------- */

  function openDeleteModal(kind, item) {
    var isLink    = kind === "link";
    var isProfile = kind === "profile";
    var label = kind;
    var title = item.title || item.name;
    var count = 0;
    if (kind === "section") {
      count = state.links.filter(function (l) { return l.sectionId === item.id; }).length;
    }

    function bodyNote() {
      if (isLink) {
        return " Everyone loses the tile - the catalog is shared.";
      }
      if (isProfile) {
        return " Their sections and page layout go with them. The shared links are not touched, " +
               "and nobody else's page changes.";
      }
      return count > 0
        ? " This section still holds <b>" + count + "</b> link(s). Deleting it puts them back " +
          "into Unsorted on your page - the links themselves are kept."
        : " The section will be removed from your page.";
    }

    /* ---- step 1: review ---- */
    var m = openModal(
      head("Delete this " + label + "?", "Step 1 of 2") +
      '<div class="modal-body">' +
        '<div class="errbar"></div>' +
        '<div class="danger-note">You are about to delete <b>' + esc(title) + "</b>." +
          bodyNote() +
        "</div>" +
        (isLink ? '<div class="hint" style="color:var(--muted);font-size:12.5px">' + esc(item.url) + "</div>" : "") +
      "</div>" +
      '<div class="modal-foot">' +
        '<button class="btn" data-close>Keep it</button>' +
        '<button class="btn btn-danger" id="d-next">Continue</button>' +
      "</div>",
      { narrow: true }
    );

    m.el.querySelector("#d-next").addEventListener("click", function () { step2(); });

    /* ---- step 2: type the confirmation word ---- */
    function step2() {
      m.el.innerHTML =
        head("Type " + DELETE_WORD + " to confirm", "Step 2 of 2") +
        '<div class="modal-body">' +
          '<div class="errbar"></div>' +
          '<div class="danger-note">This removes <b>' + esc(title) +
            "</b>. It cannot be undone from this page.</div>" +
          '<div class="field"><label for="d-word">Type <span class="confirm-word">' + esc(DELETE_WORD) +
            "</span> below to unlock the delete button</label>" +
            '<input class="input" id="d-word" autocomplete="off" spellcheck="false" placeholder="' +
            esc(DELETE_WORD) + '"></div>' +
        "</div>" +
        '<div class="modal-foot">' +
          '<button class="btn" data-close>Cancel</button>' +
          '<button class="btn btn-danger" id="d-go" disabled>Delete ' + esc(label) + "</button>" +
        "</div>";

      m.el.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", m.close); });

      var word = m.el.querySelector("#d-word");
      var go = m.el.querySelector("#d-go");

      word.addEventListener("input", function () {
        go.disabled = word.value.trim().toLowerCase() !== DELETE_WORD;
      });
      word.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !go.disabled) go.click();
      });
      word.focus();

      go.addEventListener("click", function () {
        go.disabled = true;
        go.textContent = "Deleting...";
        api(kind + ".delete", { id: item.id, confirm: word.value.trim() })
          .then(function () {
            m.close();
            toast(label.charAt(0).toUpperCase() + label.slice(1) + " deleted.");
            if (isProfile && item.id === state.profileId) {
              var next = state.profiles.filter(function (x) { return x.id !== item.id; })[0];
              if (next) { switchProfile(next.id); return; }
            }
            return load();
          })
          .catch(function (e) {
            go.disabled = false;
            go.textContent = "Delete " + label;
            showErr(m, e.message);
          });
      });
    }
  }

  /* ---------------- drag and drop ----------------
     The dragged tile is moved through the live DOM as you go, so the grid
     reflows and a real gap opens where the tile will land. Nothing highlights
     the card you happen to be over - that would say what you are hovering,
     not where the tile is going. */

  var dragEl = null;          /* the tile element being dragged */
  var dragLinkId = null;      /* its LinkID */
  var dragSectionId = null;   /* set instead when a whole section is dragged */

  /* Where would the tile land? Returns the tile to insert before, or null for
     "at the end". Grid-aware: an earlier row wins, and within a row each card's
     midpoint decides which side you are on. */
  function insertionTarget(grid, x, y) {
    var tiles = grid.querySelectorAll(".tile:not(.dragging)");
    for (var i = 0; i < tiles.length; i++) {
      var r = tiles[i].getBoundingClientRect();
      if (y < r.top) return tiles[i];
      if (y <= r.bottom && x < r.left + r.width / 2) return tiles[i];
    }
    return null;
  }

  /* A single bar element, moved between grids as needed. */
  var dropBar = null;

  function hideDropBar() {
    if (dropBar && dropBar.parentNode) dropBar.parentNode.removeChild(dropBar);
  }

  function showDropBar(grid, before) {
    if (!dropBar) dropBar = el('<div class="drop-bar"></div>');

    var tiles = grid.querySelectorAll(".tile:not(.dragging)");
    var gridRect = grid.getBoundingClientRect();
    var anchor, atEnd = false;

    if (before) {
      anchor = before;
    } else if (tiles.length) {
      anchor = tiles[tiles.length - 1];
      atEnd = true;
    } else {
      /* empty section - park the bar at the start of the row */
      if (grid !== dropBar.parentNode) grid.appendChild(dropBar);
      dropBar.style.left = "6px";
      dropBar.style.top = "6px";
      dropBar.style.height = Math.max(48, grid.clientHeight - 12) + "px";
      return;
    }

    var r = anchor.getBoundingClientRect();
    var gap = parseFloat(getComputedStyle(grid).columnGap) || 13;
    var x = atEnd ? (r.right - gridRect.left) + gap / 2
                  : (r.left - gridRect.left) - gap / 2;

    if (grid !== dropBar.parentNode) grid.appendChild(dropBar);
    dropBar.style.left = (x - 1.5) + "px";
    dropBar.style.top = (r.top - gridRect.top) + "px";
    dropBar.style.height = r.height + "px";
  }

  function bindTileDrag(tile, link) {
    tile.addEventListener("dragstart", function (e) {
      dragEl = tile;
      dragLinkId = link.id;
      dragSectionId = null;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(link.id)); } catch (ex) {}
      setTimeout(function () { if (dragEl === tile) tile.classList.add("dragging"); }, 0);
    });

    tile.addEventListener("dragend", function () {
      tile.classList.remove("dragging");
      hideDropBar();
      dragEl = null;
      dragLinkId = null;
    });
  }

  /* Sections own the drop handling, so the padding around the grid works too. */
  function enableSectionDnd(sec) {
    var grid = sec.querySelector(".grid");
    var grip = sec.querySelector(".section-grip");

    if (grip) {
      grip.addEventListener("mousedown", function () { sec.setAttribute("draggable", "true"); });
      grip.addEventListener("mouseup", function () { sec.removeAttribute("draggable"); });
    }

    sec.addEventListener("dragstart", function (e) {
      if (e.target !== sec) return;              /* a tile inside, not the section */
      dragSectionId = parseInt(sec.getAttribute("data-section"), 10);
      dragEl = null;
      sec.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", "section:" + dragSectionId); } catch (ex) {}
    });

    sec.addEventListener("dragend", function () {
      sec.classList.remove("dragging");
      sec.removeAttribute("draggable");
      dragSectionId = null;
    });

    sec.addEventListener("dragover", function (e) {
      if (dragLinkId != null && grid) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        showDropBar(grid, insertionTarget(grid, e.clientX, e.clientY));
      } else if (dragSectionId != null) {
        e.preventDefault();
      }
    });

    sec.addEventListener("dragleave", function (e) {
      if (dragLinkId != null && !sec.contains(e.relatedTarget)) hideDropBar();
    });

    sec.addEventListener("drop", function (e) {
      if (dragLinkId != null && grid) {
        e.preventDefault();
        e.stopPropagation();

        var sectionId = parseInt(sec.getAttribute("data-section"), 10);
        var before = insertionTarget(grid, e.clientX, e.clientY);
        var moving = dragLinkId;

        /* order this section will have, with the dragged link slotted in */
        var ids = [];
        [].forEach.call(grid.querySelectorAll(".tile"), function (n) {
          var id = parseInt(n.getAttribute("data-link"), 10);
          if (id === moving) return;
          if (n === before) ids.push(moving);
          ids.push(id);
        });
        if (ids.indexOf(moving) < 0) ids.push(moving);

        hideDropBar();
        if (dragEl) dragEl.classList.remove("dragging");
        dragEl = null;
        dragLinkId = null;
        if (catalogOpen) toggleCatalog(false);

        api("reorder.links", { sectionId: sectionId, ids: ids.join(",") })
          .then(load)
          .catch(function (err) { toast(err.message, "bad"); load(); });
        return;
      }

      /* otherwise reorder the sections themselves */
      var target = parseInt(sec.getAttribute("data-section"), 10);
      if (dragSectionId != null && dragSectionId !== target) {
        e.preventDefault();
        var order = state.sections.map(function (s) { return s.id; })
                      .filter(function (id) { return id !== dragSectionId; });
        var at = order.indexOf(target);
        if (at < 0) order.push(dragSectionId); else order.splice(at, 0, dragSectionId);
        dragSectionId = null;
        api("reorder.sections", { ids: order.join(",") })
          .then(load)
          .catch(function (err) { toast(err.message, "bad"); load(); });
      }
    });
  }

  /* ---------------- search + startup ---------------- */

  var searchBox = document.getElementById("q");
  var searchTimer = null;

  searchBox.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.filter = searchBox.value.trim().toLowerCase();
      render();
    }, 120);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement === document.body) {
      e.preventDefault();
      searchBox.focus();
    }
    if (e.key === "Escape" && document.activeElement === searchBox && searchBox.value) {
      searchBox.value = "";
      state.filter = "";
      render();
    }
  });

  /* No section needed. A link with no placement simply lands in Unsorted,
     which is where every link starts anyway. Requiring a section first was
     left over from before Unsorted existed. */
  document.getElementById("btnAddLink").addEventListener("click", function () {
    openLinkModal(null, null);
  });

  document.getElementById("btnAddSection").addEventListener("click", function () { openSectionModal(null); });

  var vg = document.getElementById("btnViewGrid");
  var vl = document.getElementById("btnViewList");
  var vu = document.getElementById("btnUnsorted");
  if (vg) vg.addEventListener("click", function () { setView("grid"); });
  if (vl) vl.addEventListener("click", function () { setView("list"); });
  if (vu) vu.addEventListener("click", toggleUnsorted);
  applyView();

  var signOut = document.getElementById("signOut");
  if (signOut) {
    signOut.addEventListener("click", function (e) {
      e.preventDefault();
      fetch("logout", { method: "POST" }).then(function () { location.href = "login.html"; });
    });
  }

  var catBtn = document.getElementById("btnCatalog");
  if (catBtn) {
    catBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleCatalog(); });
    document.addEventListener("click", function (e) {
      if (!catalogOpen) return;
      if (!e.target.closest(".catalog-wrap")) toggleCatalog(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && catalogOpen) toggleCatalog(false);
    });
  }

  load();
})();
