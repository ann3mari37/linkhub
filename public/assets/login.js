  document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var go = document.getElementById("go"), err = document.getElementById("err");
    go.disabled = true;
    err.classList.remove("show");
    fetch("login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "username=" + encodeURIComponent(document.getElementById("un").value)
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok) { location.href = "./"; return; }
        throw new Error(j.error || "Could not sign in.");
      })
      .catch(function (e2) {
        err.textContent = e2.message;
        err.classList.add("show");
        go.disabled = false;
      });
  });
