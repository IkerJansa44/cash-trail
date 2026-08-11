import argparse
import base64
import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid

KEY_NAMES = ("WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY")


def encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def update_environment(path: Path, subject: str) -> None:
    existing = path.read_text().splitlines() if path.exists() else []
    values = dict(
        line.split("=", 1) for line in existing if "=" in line and not line.startswith("#")
    )
    if not all(values.get(name) for name in KEY_NAMES):
        vapid = Vapid()
        vapid.generate_keys()
        values["WEB_PUSH_VAPID_PUBLIC_KEY"] = encode(
            vapid.public_key.public_bytes(
                serialization.Encoding.X962,
                serialization.PublicFormat.UncompressedPoint,
            )
        )
        values["WEB_PUSH_VAPID_PRIVATE_KEY"] = encode(
            vapid.private_key.private_bytes(
                serialization.Encoding.DER,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
    values["WEB_PUSH_VAPID_SUBJECT"] = subject
    values.setdefault("CODEX_TIMEOUT_SECONDS", "120")
    values.setdefault("NOTIFICATION_TIMEZONE", "Europe/Madrid")
    values.setdefault("MONTH_END_IMPORT_REMINDER_HOUR", "20")
    path.write_text("".join(f"{name}={value}\n" for name, value in values.items()))
    os.chmod(path, 0o600)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create stable local VAPID configuration")
    parser.add_argument("--subject", required=True)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    arguments = parser.parse_args()
    update_environment(arguments.env_file, arguments.subject)
    print(f"Configured stable VAPID keys in {arguments.env_file}")
