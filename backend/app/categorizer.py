import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .config import CODEX_TIMEOUT_SECONDS


@dataclass(frozen=True)
class Classification:
    category: str
    confidence: float


@dataclass(frozen=True)
class TransactionSuggestion:
    summary: str
    category: str
    additional_categories: tuple[str, ...]
    confidence: float


@dataclass(frozen=True)
class TopicSuggestion:
    action: str
    name: str
    parent_id: int | None
    merge_target_id: int | None
    moves: list[dict[str, int | None]]
    reason: str


def _run_codex(
    prompt: str, schema: dict[str, object], live_search: bool = False
) -> dict[str, object] | None:
    try:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            schema_path = root / "schema.json"
            output_path = root / "result.json"
            schema_path.write_text(json.dumps(schema))
            command = ["codex"]
            if live_search:
                command.append("--search")
            command.extend(
                [
                    "exec",
                    "--ephemeral",
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--sandbox",
                    "read-only",
                    "--skip-git-repo-check",
                    "--output-schema",
                    str(schema_path),
                    "--output-last-message",
                    str(output_path),
                    prompt,
                ]
            )
            subprocess.run(
                command,
                cwd=root,
                capture_output=True,
                text=True,
                timeout=CODEX_TIMEOUT_SECONDS,
                check=True,
            )
            return json.loads(output_path.read_text())
    except (FileNotFoundError, subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return None


def classify_merchants(merchants: list[str], categories: list[str]) -> dict[str, Classification]:
    if not merchants:
        return {}
    schema = {
        "type": "object",
        "properties": {
            "classifications": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "merchant": {"type": "string"},
                        "category": {"type": "string", "enum": categories},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                    "required": ["merchant", "category", "confidence"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["classifications"],
        "additionalProperties": False,
    }
    prompt = (
        "Classify each bank transaction merchant into exactly one allowed spending category. "
        "Use confidence below 0.8 when ambiguous. Do not omit any merchant.\n"
        f"Allowed categories: {json.dumps(categories, ensure_ascii=False)}\n"
        f"Merchants: {json.dumps(merchants, ensure_ascii=False)}"
    )
    payload = _run_codex(prompt, schema)
    if not payload:
        return {}
    return {
        item["merchant"]: Classification(item["category"], float(item["confidence"]))
        for item in payload["classifications"]
        if item["merchant"] in merchants
    }


def classify_transactions(
    transactions: list[dict[str, object]],
    categories: list[str],
    rule_hints: dict[str, dict[str, object]] | None = None,
) -> dict[str, TransactionSuggestion]:
    if not transactions or not categories:
        return {}
    keys = {str(item["key"]) for item in transactions}
    schema = {
        "type": "object",
        "properties": {
            "classifications": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": {"type": "string"},
                        "summary": {"type": "string"},
                        "category": {"type": "string", "enum": categories},
                        "additional_categories": {
                            "type": "array",
                            "items": {"type": "string", "enum": categories},
                            "uniqueItems": True,
                        },
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                    "required": [
                        "key",
                        "summary",
                        "category",
                        "additional_categories",
                        "confidence",
                    ],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["classifications"],
        "additionalProperties": False,
    }
    prompt = (
        "Review every personal bank transaction separately. Negative amounts are expenses; "
        "positive amounts are refunds or repayments that reduce spending. For each one, write a "
        "plain, very short sentence (at most 14 words), choose exactly one primary leaf topic, "
        "zero or more additional leaf topics, and an honest confidence score. The primary topic "
        "is the exclusive accounting allocation used in totals and stacked charts. Additional "
        "topics are overlapping context only, so include them when they materially improve search "
        "or understanding and never repeat the primary topic. Assign a positive transaction's "
        "primary topic to what it most likely reimburses. Do not omit or combine transactions. "
        "Merchant rules are only hints and may be wrong.\n"
        "Use live web search whenever a merchant is not already unambiguous. Search the exact "
        "merchant name in its likely Spanish or Catalan context, prefer reliable merchant sites "
        "and business listings, and distinguish similarly named businesses. Never invent a match; "
        "lower confidence when web evidence is inconclusive.\n"
        f"Allowed leaf topics: {json.dumps(categories, ensure_ascii=False)}\n"
        f"Prior merchant hints: {json.dumps(rule_hints or {}, ensure_ascii=False)}\n"
        f"Transactions: {json.dumps(transactions, ensure_ascii=False, default=str)}"
    )
    payload = _run_codex(prompt, schema, live_search=True)
    if not payload:
        return {}
    return {
        str(item["key"]): TransactionSuggestion(
            str(item["summary"])[:160],
            str(item["category"]),
            tuple(
                dict.fromkeys(
                    str(category)
                    for category in item["additional_categories"]
                    if str(category) in categories and str(category) != str(item["category"])
                )
            ),
            float(item["confidence"]),
        )
        for item in payload["classifications"]
        if str(item["key"]) in keys
    }


def suggest_topic(instructions: str, topics: list[dict[str, object]]) -> TopicSuggestion | None:
    topic_ids = [int(topic["id"]) for topic in topics]
    nullable_id = {"type": ["integer", "null"]}
    schema = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["place", "merge", "restructure"]},
            "name": {"type": "string"},
            "parent_id": nullable_id,
            "merge_target_id": nullable_id,
            "moves": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"topic_id": {"type": "integer"}, "new_parent_id": nullable_id},
                    "required": ["topic_id", "new_parent_id"],
                    "additionalProperties": False,
                },
            },
            "reason": {"type": "string"},
        },
        "required": ["action", "name", "parent_id", "merge_target_id", "moves", "reason"],
        "additionalProperties": False,
    }
    prompt = (
        "Turn the user's explanation into one concrete personal-spending taxonomy proposal. "
        "Choose 'place' to create a new leaf topic under an existing parent or at the root, "
        "'merge' to reuse an existing leaf topic without creating anything, or 'restructure' "
        "when moving existing topics and creating a new topic materially improves the hierarchy. "
        "For merge, merge_target_id must identify the best existing leaf. For place or restructure, "
        "choose a concise leaf-topic name and its parent_id. Never delete or rename existing "
        "topics. Topic IDs and parent IDs must be existing IDs or null. The newly created topic "
        "must remain a leaf so it can be selected for the transaction. Explain the result clearly "
        "enough for the user to approve it.\n"
        f"User explanation: {instructions}\n"
        f"Existing topics: {json.dumps(topics, ensure_ascii=False)}"
    )
    payload = _run_codex(prompt, schema)
    if not payload:
        return None
    parent_id = payload["parent_id"]
    merge_target_id = payload["merge_target_id"]
    moves = payload["moves"]
    if parent_id is not None and parent_id not in topic_ids:
        return None
    if merge_target_id is not None and merge_target_id not in topic_ids:
        return None
    if payload["action"] == "merge" and not next(
        (bool(topic.get("is_leaf")) for topic in topics if topic["id"] == merge_target_id), False
    ):
        return None
    if any(
        move["topic_id"] not in topic_ids or move["new_parent_id"] not in [None, *topic_ids]
        for move in moves
    ):
        return None
    name = str(payload["name"]).strip()[:40]
    if not name:
        return None
    return TopicSuggestion(
        action=str(payload["action"]),
        name=name,
        parent_id=parent_id,
        merge_target_id=merge_target_id,
        moves=moves,
        reason=str(payload["reason"]),
    )
