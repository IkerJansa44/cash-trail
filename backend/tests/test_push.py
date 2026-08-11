import base64
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from pywebpush import WebPushException
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app import push
from app.database import Base
from app.models import NotificationPreference, PushSubscription
from app.push import EndpointPayload, SubscriptionPayload


def session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def payload(endpoint: str = "https://push.example/subscription") -> SubscriptionPayload:
    return SubscriptionPayload.model_validate(
        {
            "endpoint": endpoint,
            "expirationTime": None,
            "keys": {
                "p256dh": encoded(b"\x04" + b"p" * 64),
                "auth": encoded(b"a" * 16),
            },
        }
    )


@pytest.fixture(autouse=True)
def configured(monkeypatch) -> None:
    monkeypatch.setattr(push, "WEB_PUSH_VAPID_PUBLIC_KEY", "public")
    monkeypatch.setattr(push, "WEB_PUSH_VAPID_PRIVATE_KEY", "private")
    monkeypatch.setattr(push, "WEB_PUSH_VAPID_SUBJECT", "mailto:test@example.com")


def test_rejects_insecure_or_malformed_subscriptions() -> None:
    data = payload().model_dump(by_alias=True)
    data["endpoint"] = "http://push.example/subscription"
    with pytest.raises(ValidationError, match="HTTPS"):
        SubscriptionPayload.model_validate(data)

    data["endpoint"] = "https://push.example/subscription"
    data["keys"]["auth"] = encoded(b"a" * 15)
    with pytest.raises(ValidationError, match="key length"):
        SubscriptionPayload.model_validate(data)


def test_subscription_upsert_is_idempotent_and_enables_channel() -> None:
    db = session()

    push.save_subscription(payload(), db)
    push.save_subscription(payload(), db)

    assert db.scalar(select(func.count()).select_from(PushSubscription)) == 1
    assert db.get(NotificationPreference, 1).iphone is True


def test_removing_last_subscription_disables_channel() -> None:
    db = session()
    item = payload()
    push.save_subscription(item, db)

    push.remove_subscription(EndpointPayload(endpoint=item.endpoint), db)

    assert db.scalar(select(func.count()).select_from(PushSubscription)) == 0
    assert db.get(NotificationPreference, 1).iphone is False


def test_push_delivery_removes_expired_endpoint(monkeypatch) -> None:
    db = session()
    push.save_subscription(payload(), db)
    response = SimpleNamespace(status_code=410)
    monkeypatch.setattr(
        push,
        "webpush",
        lambda **_kwargs: (_ for _ in ()).throw(WebPushException("gone", response=response)),
    )

    result = push.send_push(db, {"title": "Test", "body": "Body", "url": "/"})

    assert result == {"attempted": 1, "sent": 0, "removed": 1}
    assert db.scalar(select(func.count()).select_from(PushSubscription)) == 0
    assert db.get(NotificationPreference, 1).iphone is False


def test_disabled_channel_skips_delivery(monkeypatch) -> None:
    db = session()
    push.save_subscription(payload(), db)
    db.get(NotificationPreference, 1).iphone = False
    db.commit()
    calls = []
    monkeypatch.setattr(push, "webpush", lambda **kwargs: calls.append(kwargs))

    assert push.send_push(db, {"title": "Test"}) == {
        "attempted": 0,
        "sent": 0,
        "removed": 0,
    }
    assert calls == []
