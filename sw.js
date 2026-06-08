const CACHE = "divscanner-v1";
const STATIC = ["/", "/index.html", "/manifest.json"];

// ─── Install ─────────────────────────────────────────────────
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
  );
  self.skipWaiting();
});

// ─── Activate ────────────────────────────────────────────────
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── Fetch (cache-first dla statycznych) ─────────────────────
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ─── Push notification ───────────────────────────────────────
self.addEventListener("push", e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); }
  catch { data = { title: "Nowy sygnał", body: e.data.text() }; }

  const icons = {
    cross_up:    "🟢",
    cross_down:  "🔴",
    bull_fading: "🟡",
    bear_fading: "🔵",
  };

  e.waitUntil(
    self.registration.showNotification(data.title || "DivScanner", {
      body:    data.body || "",
      icon:    "/manifest.json",
      badge:   "/manifest.json",
      tag:     data.symbol || "signal",
      data:    { url: "/" },
      vibrate: [200, 100, 200],
    })
  );
});

// ─── Kliknięcie w powiadomienie ──────────────────────────────
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window" }).then(cs => {
      const c = cs.find(w => w.focused) || cs[0];
      if (c) return c.focus();
      return clients.openWindow("/");
    })
  );
});