import asyncio
import logging
from calendar import monthrange
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import MONTH_END_IMPORT_REMINDER_HOUR, NOTIFICATION_TIMEZONE
from .database import engine
from .models import ImportBatch, NotificationDelivery
from .push import send_push

CHECK_INTERVAL_SECONDS = 15 * 60
CATCH_UP_DAYS = 7
logger = logging.getLogger(__name__)


def _month_bounds_utc(month: date, timezone: ZoneInfo) -> tuple[datetime, datetime]:
    start = datetime(month.year, month.month, 1, tzinfo=timezone)
    next_month = datetime(
        month.year + (month.month == 12), month.month % 12 + 1, 1, tzinfo=timezone
    )
    return start.astimezone(UTC).replace(tzinfo=None), next_month.astimezone(UTC).replace(
        tzinfo=None
    )


def _reminder_month(local_now: datetime) -> date | None:
    last_day = monthrange(local_now.year, local_now.month)[1]
    if local_now.day == last_day and local_now.hour >= MONTH_END_IMPORT_REMINDER_HOUR:
        return local_now.date().replace(day=1)
    if local_now.day <= CATCH_UP_DAYS:
        return (local_now.date().replace(day=1) - timedelta(days=1)).replace(day=1)
    return None


def check_month_end_import_reminder(db: Session, now: datetime) -> bool:
    timezone = ZoneInfo(NOTIFICATION_TIMEZONE)
    month = _reminder_month(now.astimezone(timezone))
    if not month:
        return False

    event_key = f"missing-import:{month:%Y-%m}:iphone"
    if db.scalar(select(NotificationDelivery).where(NotificationDelivery.event_key == event_key)):
        return False

    start, end = _month_bounds_utc(month, timezone)
    if db.scalar(
        select(ImportBatch.id).where(
            ImportBatch.imported_at >= start,
            ImportBatch.imported_at < end,
        )
    ):
        return False

    result = send_push(
        db,
        {
            "title": "Bank statement import missing",
            "body": f"No bank statement was imported in {month:%B}. Open Cash Trail to import one.",
            "url": "/cash-trail/overview",
            "tag": f"missing-import-{month:%Y-%m}",
        },
    )
    if not result["sent"]:
        return False
    db.add(NotificationDelivery(event_key=event_key))
    db.commit()
    return True


async def run_notification_scheduler(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            with Session(engine) as db:
                check_month_end_import_reminder(db, datetime.now(UTC))
        except Exception:
            logger.exception("Month-end import reminder check failed")
        try:
            await asyncio.wait_for(stop.wait(), CHECK_INTERVAL_SECONDS)
        except TimeoutError:
            pass
