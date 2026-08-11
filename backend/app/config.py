import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./cash-trail.db")
CODEX_TIMEOUT_SECONDS = int(os.getenv("CODEX_TIMEOUT_SECONDS", "120"))
