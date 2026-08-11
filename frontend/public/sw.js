const appRoot = new URL("./", self.registration.scope).href;

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() };
  }
  event.waitUntil(self.registration.showNotification(payload.title ?? "Cash Trail", {
    body: payload.body ?? "Open Cash Trail for details.",
    icon: new URL("icons/icon-192.png", appRoot).href,
    badge: new URL("icons/icon-192.png", appRoot).href,
    tag: payload.tag ?? "cash-trail-notification",
    data: { url: payload.url ?? new URL("overview", appRoot).href },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requested = new URL(event.notification.data?.url ?? appRoot, self.location.origin);
  const target = requested.origin === self.location.origin ? requested.href : appRoot;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus().then(() => existing.navigate(target));
    return clients.openWindow(target);
  }));
});
