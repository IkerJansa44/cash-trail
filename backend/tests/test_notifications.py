from datetime import UTC, datetime

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app import notifications
from app.database import Base
from app.models import ImportBatch, NotificationDelivery


def session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def month_end() -> datetime:
    return datetime(2026, 8, 31, 18, tzinfo=UTC)


def test_month_end_reminder_sends_once_when_no_import_exists(monkeypatch) -> None:
    db = session()
    payloads = []
    monkeypatch.setattr(
        notifications,
        "send_push",
        lambda _db, payload: payloads.append(payload) or {"sent": 1},
    )

    assert notifications.check_month_end_import_reminder(db, month_end()) is True
    assert notifications.check_month_end_import_reminder(db, month_end()) is False
    assert payloads[0]["tag"] == "missing-import-2026-08"
    assert db.scalar(select(func.count()).select_from(NotificationDelivery)) == 1


def test_month_end_reminder_skips_month_with_an_import(monkeypatch) -> None:
    db = session()
    db.add(
        ImportBatch(
            filename="august.xlsx",
            imported_at=datetime(2026, 8, 15, 10, tzinfo=UTC).replace(tzinfo=None),
            imported_count=1,
            duplicate_count=0,
        )
    )
    db.commit()
    calls = []
    monkeypatch.setattr(notifications, "send_push", lambda *_args: calls.append(True))

    assert notifications.check_month_end_import_reminder(db, month_end()) is False
    assert calls == []


def test_month_end_reminder_waits_until_configured_hour(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(notifications, "send_push", lambda *_args: calls.append(True))

    assert (
        notifications.check_month_end_import_reminder(
            session(), datetime(2026, 8, 31, 17, 59, tzinfo=UTC)
        )
        is False
    )
    assert calls == []


def test_failed_delivery_remains_retryable(monkeypatch) -> None:
    db = session()
    monkeypatch.setattr(notifications, "send_push", lambda *_args: {"sent": 0})

    assert notifications.check_month_end_import_reminder(db, month_end()) is False
    assert db.scalar(select(func.count()).select_from(NotificationDelivery)) == 0


def test_missed_month_end_is_caught_up_after_restart(monkeypatch) -> None:
    db = session()
    payloads = []
    monkeypatch.setattr(
        notifications,
        "send_push",
        lambda _db, payload: payloads.append(payload) or {"sent": 1},
    )

    assert (
        notifications.check_month_end_import_reminder(db, datetime(2026, 9, 3, 8, tzinfo=UTC))
        is True
    )
    assert payloads[0]["tag"] == "missing-import-2026-08"
