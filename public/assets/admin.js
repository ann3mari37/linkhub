(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function showErr(el, msg) { el.textContent = msg; el.classList.add("show"); }
  function clearErr(el) { el.textContent = ""; el.classList.remove("show"); }

  function call(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "The server returned an unexpected response." }; })
        .then(function (j) {
          if (r.status === 401 && url.indexOf("admin/api/") === 0) { showLogin(); }
          if (!j.ok) throw new Error(j.error || "Something went wrong.");
          return j;
        });
    });
  }

  function showLogin() {
    $("main").hidden = true;
    $("out").hidden = true;
    $("loginCard").hidden = false;
    $("pw").focus();
  }

  function showMain() {
    $("loginCard").hidden = true;
    $("main").hidden = false;
    $("out").hidden = false;
  }

  function load() {
    return call("GET", "admin/api/families").then(function (j) {
      showMain();
      render(j.families);
    }).catch(function (e) {
      if (!$("loginCard").hidden) return;
      showErr($("listErr"), e.message);
    });
  }

  function render(families) {
    var list = $("list");
    if (!families.length) { list.innerHTML = '<div class="muted">No families yet. Add the first one above.</div>'; return; }
    list.innerHTML = families.map(function (f) {
      var only = f.usernames.length <= 1;
      return '<div class="fam" data-id="' + f.id + '">' +
               '<div class="fam-main">' +
                 '<div class="fam-name">' + esc(f.name) + "</div>" +
                 '<div class="fam-meta">' +
                   f.profiles + " member" + (f.profiles === 1 ? "" : "s") + " &middot; " +
                   f.links + " link" + (f.links === 1 ? "" : "s") + "</div>" +
                 '<div class="unames">' +
                   f.usernames.map(function (u) {
                     return '<span class="uname">' + esc(u.username) +
                              '<button type="button" data-uid="' + u.id + '" ' +
                                (only ? 'title="A family needs at least one username" disabled style="visibility:hidden"'
                                      : 'title="Remove ' + esc(u.username) + '" aria-label="Remove ' + esc(u.username) + '"') +
                              ">&times;</button></span>";
                   }).join("") +
                   '<form class="uname-add">' +
                     '<input class="input" maxlength="40" placeholder="Add a username" autocapitalize="none" spellcheck="false" aria-label="New username for ' + esc(f.name) + '">' +
                     '<button class="btn btn-sm" type="submit">Add</button>' +
                   "</form>" +
                 "</div>" +
               "</div>" +
               '<div class="fam-acts">' +
                 '<button class="btn btn-sm" data-act="edit">Rename</button>' +
                 '<button class="btn btn-sm btn-ghost" data-act="del">Delete</button>' +
               "</div>" +
               '<div class="errbar fam-err"></div>' +
             "</div>";
    }).join("");

    families.forEach(function (f) {
      var row = list.querySelector('[data-id="' + f.id + '"]');
      var err = row.querySelector(".fam-err");
      row.querySelector('[data-act="edit"]').addEventListener("click", function () { editRow(row, f); });
      row.querySelector('[data-act="del"]').addEventListener("click", function () { deleteRow(row, f); });

      row.querySelectorAll("[data-uid]").forEach(function (b) {
        b.addEventListener("click", function () {
          var name = b.parentNode.firstChild.nodeValue;
          if (!confirm("Remove the username " + name + "? Anyone signed in with it is signed out.")) return;
          b.disabled = true;
          call("POST", "admin/api/usernames/" + b.getAttribute("data-uid") + "/delete")
            .then(load).catch(function (e) { b.disabled = false; showErr(err, e.message); });
        });
      });

      var add = row.querySelector(".uname-add");
      add.addEventListener("submit", function (e) {
        e.preventDefault();
        clearErr(err);
        var input = add.querySelector("input");
        call("POST", "admin/api/families/" + f.id + "/usernames", { username: input.value })
          .then(load).catch(function (e2) { showErr(err, e2.message); input.focus(); });
      });
    });
  }

  function panel(row, html) {
    var old = row.querySelector(".fam-edit");
    if (old) old.parentNode.removeChild(old);
    var d = document.createElement("div");
    d.className = "fam-edit";
    d.innerHTML = html;
    row.appendChild(d);
    return d;
  }

  function editRow(row, f) {
    var p = panel(row,
      '<div class="errbar"></div>' +
      '<div class="row2">' +
        '<div class="field"><label>Family name</label><input class="input" data-f="name" maxlength="100" value="' + esc(f.name) + '"></div>' +
        '<button class="btn btn-primary" data-f="save">Save</button>' +
        '<button class="btn" data-f="cancel">Cancel</button>' +
      "</div>");
    p.querySelector('[data-f="cancel"]').addEventListener("click", function () { p.parentNode.removeChild(p); });
    p.querySelector('[data-f="save"]').addEventListener("click", function () {
      var btn = this;
      btn.disabled = true;
      call("POST", "admin/api/families/" + f.id, {
        name: p.querySelector('[data-f="name"]').value
      }).then(load).catch(function (e) {
        btn.disabled = false;
        showErr(p.querySelector(".errbar"), e.message);
      });
    });
  }

  function deleteRow(row, f) {
    var p = panel(row,
      '<div class="errbar"></div>' +
      '<div class="danger-note">This deletes <b>' + esc(f.name) + "</b> and everything in it: " +
        f.usernames.length + " username(s), " + f.profiles + " member(s), " + f.links +
        " link(s), and all their sections. It cannot be undone.</div>" +
      '<div class="row2" style="margin-top:10px">' +
        '<div class="field"><label>Type the family name, <span class="confirm-word">' + esc(f.name) + "</span>, to confirm</label>" +
          '<input class="input" data-f="word" autocomplete="off" spellcheck="false"></div>' +
        '<button class="btn btn-danger" data-f="go" disabled>Delete family</button>' +
        '<button class="btn" data-f="cancel">Cancel</button>' +
      "</div>");
    var word = p.querySelector('[data-f="word"]'), go = p.querySelector('[data-f="go"]');
    word.focus();
    word.addEventListener("input", function () {
      go.disabled = word.value.trim().toLowerCase() !== f.name.trim().toLowerCase();
    });
    p.querySelector('[data-f="cancel"]').addEventListener("click", function () { p.parentNode.removeChild(p); });
    go.addEventListener("click", function () {
      go.disabled = true;
      call("POST", "admin/api/families/" + f.id + "/delete", { confirm: word.value })
        .then(load).catch(function (e) {
          go.disabled = false;
          showErr(p.querySelector(".errbar"), e.message);
        });
    });
  }

  $("loginCard").addEventListener("submit", function (e) {
    e.preventDefault();
    clearErr($("loginErr"));
    call("POST", "admin/login", { password: $("pw").value })
      .then(function () { $("pw").value = ""; return load(); })
      .catch(function (e2) { showErr($("loginErr"), e2.message); });
  });

  $("addCard").addEventListener("submit", function (e) {
    e.preventDefault();
    clearErr($("addErr"));
    call("POST", "admin/api/families", { name: $("a-name").value, username: $("a-user").value })
      .then(function () { $("a-name").value = ""; $("a-user").value = ""; return load(); })
      .catch(function (e2) { showErr($("addErr"), e2.message); });
  });

  $("out").addEventListener("click", function () {
    call("POST", "admin/logout").then(showLogin, showLogin);
  });

  load();
})();
