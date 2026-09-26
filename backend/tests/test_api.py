from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from app.database import Base
from app.main import app, initialize_database


def test_health() -> None:
    assert TestClient(app).get("/api/health").json() == {"status": "ok"}


def test_existing_database_gains_transaction_label_columns(monkeypatch) -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("ALTER TABLE transactions DROP COLUMN transaction_label")
        connection.exec_driver_sql("ALTER TABLE transactions DROP COLUMN label_updated_at")
    monkeypatch.setattr("app.main.engine", engine)

    initialize_database()

    with engine.connect() as connection:
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(transactions)")}
    assert {"transaction_label", "label_updated_at"}.issubset(columns)
