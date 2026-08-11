import base64
import json
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator
from pywebpush import WebPushException, webpush
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .config import (
    MONTH_END_IMPORT_REMINDER_HOUR,
    NOTIFICATION_TIMEZONE,
    WEB_PUSH_VAPID_PRIVATE_KEY,
    WEB_PUSH_VAPID_PUBLIC_KEY,
    WEB_PUSH_VAPID_SUBJECT,
)
from .database import get_db
from .models import NotificationPreference, PushSubscription

logger = logging.getLogger(__name__)
router = APIRouter()
DatabaseSession = Annotated[Session, Depends(get_db)]


class SubscriptionKeys(BaseModel):
    p256dh: str = Field(min_length=80, max_length=128)
    auth: str = Field(min_length=20, max_length=64)

    @field_validator("p256dh", "auth")
    @classmethod
    def validate_base64url(cls, value: str, info: ValidationInfo) -> str:
        try:
            decoded = base64.b64decode(
                value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
            )
        except ValueError as error:
            raise ValueError("must be base64url encoded") from error
        expected_length = {"p256dh": 65, "auth": 16}[info.field_name]
        if len(decoded) != expected_length:
            raise ValueError("has an invalid key length")
        return value


class SubscriptionPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    endpoint: str = Field(min_length=1, max_length=2048)
    expiration_time: float | None = Field(default=None, alias="expirationTime")
    keys: SubscriptionKeys

    @field_validator("endpoint")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        if not value.startswith("https://"):
            raise ValueError("must use HTTPS")
        return value


class EndpointPayload(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)


class PreferencePayload(BaseModel):
    iphone: bool


def _preference(db: Session) -> NotificationPreference:
    preference = db.get(NotificationPreference, 1)
    if preference:
        return preference
    preference = NotificationPreference(id=1)
    db.add(preference)
    return preference


def _require_configuration() -> None:
    if not all((WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY, WEB_PUSH_VAPID_SUBJECT)):
        raise HTTPException(503, "iPhone notifications are not configured on the server")


@router.get("/api/push/public-key")
def public_key() -> dict[str, str]:
    if not WEB_PUSH_VAPID_PUBLIC_KEY:
        raise HTTPException(503, "iPhone notifications are not configured on the server")
    return {"public_key": WEB_PUSH_VAPID_PUBLIC_KEY}


@router.post("/api/push/subscriptions")
def save_subscription(payload: SubscriptionPayload, db: DatabaseSession) -> dict[str, bool]:
    _require_configuration()
    subscription = db.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )
    if not subscription:
        subscription = PushSubscription(endpoint=payload.endpoint)
        db.add(subscription)
    subscription.expiration_time = payload.expiration_time
    subscription.p256dh = payload.keys.p256dh
    subscription.auth = payload.keys.auth
    _preference(db).iphone = True
    db.commit()
    return {"enabled": True}


@router.delete("/api/push/subscriptions")
def remove_subscription(payload: EndpointPayload, db: DatabaseSession) -> dict[str, bool]:
    db.execute(delete(PushSubscription).where(PushSubscription.endpoint == payload.endpoint))
    if not db.scalar(select(func.count()).select_from(PushSubscription)):
        _preference(db).iphone = False
    db.commit()
    return {"enabled": False}


@router.get("/api/notification-preferences")
def notification_preferences(db: DatabaseSession) -> dict[str, bool | int | str]:
    preference = db.get(NotificationPreference, 1)
    return {
        "iphone": bool(preference and preference.iphone),
        "subscriptions": db.scalar(select(func.count()).select_from(PushSubscription)) or 0,
        "month_end_import_reminder": True,
        "reminder_hour": MONTH_END_IMPORT_REMINDER_HOUR,
        "timezone": NOTIFICATION_TIMEZONE,
    }


@router.put("/api/notification-preferences")
def update_notification_preferences(
    payload: PreferencePayload, db: DatabaseSession
) -> dict[str, bool]:
    if payload.iphone and not db.scalar(select(func.count()).select_from(PushSubscription)):
        raise HTTPException(409, "Subscribe this device before enabling iPhone notifications")
    _preference(db).iphone = payload.iphone
    db.commit()
    return {"iphone": payload.iphone}


def send_push(db: Session, payload: dict[str, str]) -> dict[str, int]:
    _require_configuration()
    preference = db.get(NotificationPreference, 1)
    if not preference or not preference.iphone:
        return {"attempted": 0, "sent": 0, "removed": 0}

    subscriptions = list(db.scalars(select(PushSubscription)))
    result = {"attempted": len(subscriptions), "sent": 0, "removed": 0}
    for subscription in subscriptions:
        try:
            webpush(
                subscription_info={
                    "endpoint": subscription.endpoint,
                    "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
                },
                data=json.dumps(payload),
                vapid_private_key=WEB_PUSH_VAPID_PRIVATE_KEY,
                vapid_claims={"sub": WEB_PUSH_VAPID_SUBJECT},
                ttl=300,
                timeout=10,
            )
            result["sent"] += 1
        except WebPushException as error:
            status_code = getattr(error.response, "status_code", None)
            if status_code in {404, 410}:
                db.delete(subscription)
                result["removed"] += 1
                continue
            logger.warning(
                "Web Push delivery failed for subscription %s: %s", subscription.id, error
            )
    if result["removed"]:
        if result["removed"] == len(subscriptions):
            preference.iphone = False
        db.commit()
    return result


@router.post("/api/push/test")
def send_test_push(db: DatabaseSession) -> dict[str, int]:
    if not db.scalar(select(func.count()).select_from(PushSubscription)):
        raise HTTPException(409, "No iPhone is subscribed")
    result = send_push(
        db,
        {
            "title": "Cash Trail notifications are ready",
            "body": "This iPhone can receive private Cash Trail alerts.",
            "url": "/cash-trail/overview",
            "tag": "cash-trail-test",
        },
    )
    if not result["sent"]:
        raise HTTPException(502, "The push service did not accept the test notification")
    return result
