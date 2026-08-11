import { BellRing, CalendarClock, Check, ExternalLink, LoaderCircle, Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "./api";

type Preferences = {
  iphone: boolean;
  subscriptions: number;
  month_end_import_reminder?: boolean;
  reminder_hour?: number;
  timezone?: string;
};
const appBase = import.meta.env.BASE_URL.replace(/\/$/, "");

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${"=".repeat((4 - value.length % 4) % 4)}`;
  const bytes = Uint8Array.from(atob(padded.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  return new Uint8Array(bytes.buffer);
}

export default function NotificationsPage() {
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const applicationServerKey = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [preferences, setPreferences] = useState<Preferences>({ iphone: false, subscriptions: 0 });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    Promise.all([
      navigator.serviceWorker.ready,
      apiRequest<{ public_key: string }>("/api/push/public-key"),
      apiRequest<Preferences>("/api/notification-preferences"),
    ]).then(async ([serviceWorker, keys, savedPreferences]) => {
      const current = await serviceWorker.pushManager.getSubscription();
      if (!active) return;
      registration.current = serviceWorker;
      applicationServerKey.current = decodeBase64Url(keys.public_key);
      setSubscription(current);
      setPreferences(savedPreferences);
      setReady(true);
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Notifications are unavailable"));
    return () => { active = false; };
  }, [supported]);

  const enable = async () => {
    if (!registration.current || !applicationServerKey.current) return;
    setBusy(true);
    setMessage("");
    try {
      const current = subscription ?? await registration.current.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey.current,
      });
      await apiRequest("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current.toJSON()),
      });
      setSubscription(current);
      setPreferences((value) => ({ iphone: true, subscriptions: value.subscriptions + (subscription ? 0 : 1) }));
      setMessage("Notifications are enabled on this device.");
    } catch (error) {
      setMessage(Notification.permission === "denied"
        ? "Notifications are blocked. Allow Cash Trail in iPhone Settings → Notifications."
        : error instanceof Error ? error.message : "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!subscription) return;
    setBusy(true);
    setMessage("");
    try {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      await apiRequest("/api/push/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      setSubscription(null);
      setPreferences((value) => ({ iphone: value.subscriptions > 1, subscriptions: Math.max(0, value.subscriptions - 1) }));
      setMessage("Notifications are disabled on this device.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not disable notifications");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setMessage("");
    try {
      await apiRequest("/api/push/test", { method: "POST" });
      setMessage("Test sent. It should arrive in a moment.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not send the test notification");
    } finally {
      setBusy(false);
    }
  };

  return <div className="notification-settings">
    <section className="panel notification-card">
      <div className="notification-icon"><BellRing /></div>
      <div>
        <p className="eyebrow">IPHONE DELIVERY</p>
        <h2>Web Push notifications</h2>
        <p>Receive private Cash Trail alerts from the Home Screen app, even when it is closed.</p>
      </div>
      <span className={subscription ? "channel-status enabled" : "channel-status"}>
        {subscription ? <><Check />Enabled here</> : "Off on this device"}
      </span>
    </section>

    {!standalone && <section className="panel install-card">
      <Smartphone />
      <div><strong>Install Cash Trail on your iPhone first</strong><p>Open the HTTPS site in Safari, tap Share, choose Add to Home Screen, then launch it from its icon.</p></div>
      <ExternalLink />
    </section>}

    <section className="panel notification-controls">
      <div><h2>This device</h2><p>{preferences.subscriptions} subscribed {preferences.subscriptions === 1 ? "device" : "devices"} · Permission: {supported ? Notification.permission : "unsupported"}</p></div>
      <div>
        {subscription
          ? <><button className="secondary-notification-action" onClick={disable} disabled={busy}>Disable here</button><button className="primary-notification-action" onClick={sendTest} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <BellRing />}Send test</button></>
          : <button className="primary-notification-action" onClick={enable} disabled={!ready || busy}>{busy ? <LoaderCircle className="spin" /> : <BellRing />}Enable on this device</button>}
      </div>
    </section>

    <section className="panel reminder-card">
      <CalendarClock />
      <div><strong>Month-end import reminder</strong><p>If no statement was imported during the calendar month, Cash Trail checks at {String(preferences.reminder_hour ?? 20).padStart(2, "0")}:00 {preferences.timezone ?? "Europe/Madrid"} on its final day and sends one reminder.</p></div>
      <span>Active</span>
    </section>

    {!supported && <p className="notification-message error">This browser does not support Web Push.</p>}
    {message && <p className="notification-message">{message}</p>}
    <p className="notification-footnote">Permission is requested only when you tap Enable. Cash Trail stores one subscription per device and automatically removes expired endpoints rejected by the push service.</p>
  </div>;
}
