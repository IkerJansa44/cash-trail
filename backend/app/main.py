import asyncio
import json
from calendar import monthrange
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import Annotated
from unicodedata import normalize

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from .categorizer import classify_transactions, suggest_topic
from .database import Base, engine, get_db
from .importer import ImportedTransaction, parse_file
from .models import (
    Category,
    ImportBatch,
    MerchantRule,
    MerchantTagRule,
    ProposedTransactionTag,
    StatementCoverage,
    TopicProposal,
    Transaction,
    TransactionTag,
)
from .notifications import run_notification_scheduler
from .push import router as push_router

CATEGORY_SEEDS = [
    ("Housing", "#7357D9"),
    ("Groceries", "#31A37C"),
    ("Dining", "#E97852"),
    ("Transport", "#4A7BE7"),
    ("Shopping", "#D4548C"),
    ("Entertainment", "#9C66C6"),
    ("Travel", "#3AA6B9"),
    ("Health & Wellbeing", "#4E9B7A"),
    ("Health", "#D95050"),
    ("Sports", "#3A9B80"),
    ("Personal Care", "#C76D9A"),
    ("Friends", "#7A68C7"),
    ("Subscriptions", "#7B82E6"),
    ("Utilities", "#D79C37"),
    ("Fees", "#9098A8"),
    ("Other", "#B2B8C5"),
]


class ReviewApprovalItem(BaseModel):
    transaction_id: int
    description: str = Field(min_length=1, max_length=160)
    category_id: int
    additional_category_ids: list[int] = Field(default_factory=list)
    transaction_label: str | None = Field(default=None, max_length=60)


class ReviewApprovalRequest(BaseModel):
    items: list[ReviewApprovalItem] = Field(min_length=1)


class ReviewClassificationRequest(BaseModel):
    transaction_ids: list[int] = Field(min_length=1, max_length=25)


class TransactionTopicsUpdate(BaseModel):
    description: str = Field(min_length=1, max_length=160)
    category_id: int
    additional_category_ids: list[int] = Field(default_factory=list)
    transaction_label: str | None = Field(default=None, max_length=60)


class TransactionExclusionUpdate(BaseModel):
    excluded: bool


class TopicCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    parent_id: int | None = None


class TopicProposalRequest(BaseModel):
    instructions: str = Field(min_length=1, max_length=1000)


class TopicUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    parent_id: int | None = None


class TopicMerge(BaseModel):
    target_id: int


def initialize_database() -> None:
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(categories)")}
        if "parent_id" not in columns:
            connection.exec_driver_sql(
                "ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id)"
            )
        transaction_columns = {
            row[1] for row in connection.exec_driver_sql("PRAGMA table_info(transactions)")
        }
        if "ai_description" not in transaction_columns:
            connection.exec_driver_sql("ALTER TABLE transactions ADD COLUMN ai_description TEXT")
        if "proposed_category_id" not in transaction_columns:
            connection.exec_driver_sql(
                "ALTER TABLE transactions ADD COLUMN proposed_category_id INTEGER "
                "REFERENCES categories(id)"
            )
        if "transaction_label" not in transaction_columns:
            connection.exec_driver_sql(
                "ALTER TABLE transactions ADD COLUMN transaction_label VARCHAR(60)"
            )
        if "label_updated_at" not in transaction_columns:
            connection.exec_driver_sql(
                "ALTER TABLE transactions ADD COLUMN label_updated_at DATETIME"
            )
    with Session(engine) as session:
        session.execute(
            update(Transaction)
            .where(
                Transaction.status == "confirmed",
                Transaction.classification_source.in_(("codex", "rule")),
            )
            .values(
                proposed_category_id=Transaction.category_id,
                category_id=None,
                status="pending",
            )
        )
        session.execute(
            update(Transaction)
            .where(
                Transaction.status == "pending",
                Transaction.proposed_category_id.is_(None),
                Transaction.category_id.is_not(None),
            )
            .values(proposed_category_id=Transaction.category_id)
        )
        session.execute(
            update(Transaction)
            .where(Transaction.status == "pending", Transaction.category_id.is_not(None))
            .values(category_id=None)
        )
        for transaction in session.scalars(select(Transaction).where(Transaction.amount >= 0)):
            exclusion = _exclusion_reason(transaction.amount, transaction.description)
            if exclusion:
                transaction.status = "excluded"
                transaction.classification_source = "excluded"
                transaction.exclusion_reason = exclusion
                transaction.category_id = None
                transaction.proposed_category_id = None
                session.execute(
                    delete(TransactionTag).where(TransactionTag.transaction_id == transaction.id)
                )
                session.execute(
                    delete(ProposedTransactionTag).where(
                        ProposedTransactionTag.transaction_id == transaction.id
                    )
                )
            elif transaction.status == "excluded" and transaction.exclusion_reason in {
                None,
                "income_or_refund",
            }:
                transaction.status = "pending"
                transaction.classification_source = "unclassified"
                transaction.exclusion_reason = None
        existing = set(session.scalars(select(Category.name)))
        session.add_all(
            Category(name=name, color=color)
            for name, color in CATEGORY_SEEDS
            if name not in existing
        )
        session.flush()
        topics = {item.name: item for item in session.scalars(select(Category))}
        wellbeing = topics["Health & Wellbeing"]
        for name in ("Health", "Sports", "Personal Care"):
            topics[name].parent_id = wellbeing.id
        cash = topics.get("Cash")
        if cash:
            other = topics["Other"]
            session.execute(
                update(Transaction)
                .where(Transaction.category_id == cash.id)
                .values(category_id=other.id)
            )
            session.execute(
                update(Transaction)
                .where(Transaction.proposed_category_id == cash.id)
                .values(proposed_category_id=other.id)
            )
            session.execute(
                update(MerchantRule)
                .where(MerchantRule.category_id == cash.id)
                .values(category_id=other.id)
            )
            session.execute(
                update(Category).where(Category.parent_id == cash.id).values(parent_id=other.id)
            )
            session.delete(cash)
        covered_batches = set(session.scalars(select(StatementCoverage.import_batch_id)))
        for batch_id in session.scalars(select(ImportBatch.id)):
            if batch_id in covered_batches:
                continue
            dates = list(
                session.scalars(
                    select(Transaction.operation_date).where(
                        Transaction.import_batch_id == batch_id
                    )
                )
            )
            if dates:
                session.add(
                    StatementCoverage(
                        import_batch_id=batch_id,
                        start_date=min(dates),
                        end_date=max(dates),
                        source="transactions",
                    )
                )
        session.commit()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    initialize_database()
    stop = asyncio.Event()
    scheduler = asyncio.create_task(run_notification_scheduler(stop))
    try:
        yield
    finally:
        stop.set()
        await scheduler


app = FastAPI(title="Cash Trail", version="0.1.0", lifespan=lifespan)
app.include_router(push_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DatabaseSession = Annotated[Session, Depends(get_db)]
StatementFile = Annotated[UploadFile, File()]


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/categories")
def categories(db: DatabaseSession) -> list[dict[str, object]]:
    topics = list(db.scalars(select(Category).order_by(Category.name)))
    paths, children = _topic_paths(topics)
    return [
        {
            "id": item.id,
            "name": item.name,
            "color": item.color,
            "parent_id": item.parent_id,
            "path": paths[item.id],
            "is_leaf": not children[item.id],
        }
        for item in topics
    ]


@app.post("/api/imports")
async def import_transactions(file: StatementFile, db: DatabaseSession) -> dict[str, object]:
    if not file.filename:
        raise HTTPException(400, "A filename is required")
    try:
        statement = parse_file(file.filename, await file.read())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    parsed = statement.transactions
    unique_items = list({item.fingerprint: item for item in parsed}.values())
    fingerprints = {item.fingerprint for item in unique_items}
    existing = set(
        db.scalars(select(Transaction.fingerprint).where(Transaction.fingerprint.in_(fingerprints)))
    )
    new_items = [item for item in unique_items if item.fingerprint not in existing]
    duplicate_count = len(parsed) - len(new_items)
    batch = ImportBatch(
        filename=file.filename, imported_count=len(new_items), duplicate_count=duplicate_count
    )
    db.add(batch)
    db.flush()
    db.add(
        StatementCoverage(
            import_batch_id=batch.id,
            start_date=statement.coverage_start,
            end_date=statement.coverage_end,
            source=statement.coverage_source,
        )
    )
    _store_transactions(db, batch.id, new_items)
    db.commit()
    pending = (
        db.scalar(
            select(func.count()).select_from(Transaction).where(Transaction.status == "pending")
        )
        or 0
    )
    return {"imported": len(new_items), "duplicates": duplicate_count, "pending_review": pending}


@app.get("/api/coverage")
def statement_coverage(db: DatabaseSession) -> dict[str, object]:
    ranges = list(db.scalars(select(StatementCoverage).order_by(StatementCoverage.start_date)))
    if not ranges:
        return {"start": None, "end": None, "gaps": []}
    merged: list[list[date]] = []
    for item in ranges:
        if not merged or item.start_date > merged[-1][1] + timedelta(days=1):
            merged.append([item.start_date, item.end_date])
        elif item.end_date > merged[-1][1]:
            merged[-1][1] = item.end_date
    gaps = [
        {
            "start": (current[1] + timedelta(days=1)).isoformat(),
            "end": (following[0] - timedelta(days=1)).isoformat(),
            "days": (following[0] - current[1]).days - 1,
        }
        for current, following in pairwise(merged)
    ]
    return {
        "start": merged[0][0].isoformat(),
        "end": merged[-1][1].isoformat(),
        "gaps": gaps,
    }


def _store_transactions(db: Session, batch_id: int, items: list[ImportedTransaction]) -> None:
    topics = list(db.scalars(select(Category)))
    categories_by_name = {item.name: item for item in topics}
    categories_by_id = {item.id: item for item in topics}
    rule_hints = _merchant_rule_hints(db, categories_by_id)
    classifiable = [item for item in items if not _excluded(item)]
    inferred = classify_transactions(
        [_imported_classification_payload(item) for item in classifiable],
        list(categories_by_name),
        rule_hints,
    )

    for item in items:
        exclusion = _excluded(item)
        result = inferred.get(item.fingerprint)
        transaction = Transaction(
            operation_date=item.operation_date,
            value_date=item.value_date,
            description=item.description,
            merchant=item.merchant,
            amount=item.amount,
            balance=item.balance,
            currency=item.currency,
            fingerprint=item.fingerprint,
            status="excluded" if exclusion else "pending",
            classification_source=(
                "excluded" if exclusion else "codex" if result else "unclassified"
            ),
            ai_description=result.summary if result else None,
            confidence=result.confidence if result else None,
            exclusion_reason=exclusion,
            category_id=None,
            proposed_category_id=(categories_by_name[result.category].id if result else None),
            import_batch_id=batch_id,
        )
        db.add(transaction)
        db.flush()
        if result:
            db.add_all(
                ProposedTransactionTag(
                    transaction_id=transaction.id,
                    category_id=categories_by_name[name].id,
                )
                for name in result.additional_categories
            )


def _merchant_rule_hints(
    db: Session, categories: dict[int, Category]
) -> dict[str, dict[str, object]]:
    primary = {
        rule.merchant: categories[rule.category_id].name
        for rule in db.scalars(select(MerchantRule))
        if rule.category_id in categories
    }
    additional: dict[str, list[str]] = defaultdict(list)
    for rule in db.scalars(select(MerchantTagRule)):
        if rule.category_id in categories:
            additional[rule.merchant].append(categories[rule.category_id].name)
    return {
        merchant: {
            "primary": primary.get(merchant),
            "additional": additional.get(merchant, []),
        }
        for merchant in primary.keys() | additional.keys()
    }


def _imported_classification_payload(item: ImportedTransaction) -> dict[str, object]:
    return {
        "key": item.fingerprint,
        "date": item.operation_date.isoformat(),
        "merchant": item.merchant,
        "bank_description": item.description,
        "amount_eur": float(item.amount),
    }


def _excluded(item: ImportedTransaction) -> str | None:
    return _exclusion_reason(item.amount, item.description)


def _exclusion_reason(amount: Decimal, description: str) -> str | None:
    normalized = normalize("NFKD", description.upper()).encode("ascii", "ignore").decode()
    if amount > 0 and "NOMINA" in normalized:
        return "payroll"
    if normalized.startswith(("TRANSFERENCIA", "TRASPASO", "TRASPAS")):
        return "transfer"
    if amount == 0:
        return "zero_amount"
    return None


@app.get("/api/dashboard")
def dashboard(
    db: DatabaseSession,
    year: int | None = None,
    month: int | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
) -> dict[str, object]:
    latest = db.scalar(select(func.max(Transaction.operation_date))) or datetime.now(UTC).date()
    selected_year, selected_month = year or latest.year, month or latest.month
    if bool(start_date) != bool(end_date):
        raise HTTPException(400, "Both start_date and end_date are required")
    if start_date and end_date and start_date > end_date:
        raise HTTPException(400, "The start date must be before the end date")
    custom_range = bool(start_date and end_date)
    range_start = start_date or date(selected_year, selected_month, 1)
    range_end = end_date or date(
        selected_year, selected_month, monthrange(selected_year, selected_month)[1]
    )
    transactions = list(
        db.scalars(
            select(Transaction)
            .where(Transaction.status != "excluded")
            .order_by(Transaction.operation_date.desc(), Transaction.id.desc())
        )
    )
    categories_by_id = {item.id: item for item in db.scalars(select(Category))}
    roots = _root_topics(categories_by_id)
    selected = [item for item in transactions if range_start <= item.operation_date <= range_end]
    if custom_range:
        previous_end = range_start - timedelta(days=1)
        previous_start = previous_end - timedelta(days=(range_end - range_start).days)
        previous = [
            item for item in transactions if previous_start <= item.operation_date <= previous_end
        ]
    else:
        previous_year, previous_month = (
            (selected_year - 1, 12) if selected_month == 1 else (selected_year, selected_month - 1)
        )
        previous = [
            item
            for item in transactions
            if item.operation_date.year == previous_year
            and item.operation_date.month == previous_month
        ]
    total = sum((-item.amount for item in selected), Decimal())
    previous_total = sum((-item.amount for item in previous), Decimal())
    change = float((total - previous_total) / previous_total * 100) if previous_total else None
    by_category: dict[str, Decimal] = defaultdict(Decimal)
    for item in selected:
        by_category[
            roots[item.category_id].name if item.category_id else "Pending review"
        ] += -item.amount
    monthly: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    for item in selected if custom_range else transactions:
        key = item.operation_date.strftime("%Y-%m")
        category = roots[item.category_id].name if item.category_id else "Pending review"
        monthly[key][category] += -item.amount
    pending_total = (
        db.scalar(
            select(func.count()).select_from(Transaction).where(Transaction.status == "pending")
        )
        or 0
    )
    return {
        "period": f"{selected_year:04d}-{selected_month:02d}",
        "range_start": range_start.isoformat(),
        "range_end": range_end.isoformat(),
        "is_custom": custom_range,
        "available_periods": sorted(
            {item.operation_date.strftime("%Y-%m") for item in transactions}, reverse=True
        ),
        "total": float(total),
        "change": change,
        "average": float(total / len(selected)) if selected else 0,
        "count": len(selected),
        "expense_count": sum(item.amount < 0 for item in selected),
        "credit_count": sum(item.amount > 0 for item in selected),
        "pending": sum(item.status == "pending" for item in selected),
        "pending_total": pending_total,
        "categories": [
            {"name": name, "value": float(value), "color": _category_color(name, categories_by_id)}
            for name, value in sorted(by_category.items(), key=lambda pair: pair[1], reverse=True)
        ],
        "monthly": [
            {"month": key, **{name: float(value) for name, value in values.items()}}
            for key, values in (
                sorted(monthly.items()) if custom_range else sorted(monthly.items())[-12:]
            )
        ],
        "recent": [_serialize_transaction(item, categories_by_id) for item in selected[:8]],
        "transactions": [_serialize_transaction(item, categories_by_id) for item in selected],
    }


def _category_color(name: str, categories: dict[int, Category]) -> str:
    return next((item.color for item in categories.values() if item.name == name), "#D5D9E2")


def _topic_paths(topics: list[Category]) -> tuple[dict[int, str], dict[int, list[int]]]:
    by_id = {item.id: item for item in topics}
    children = {item.id: [] for item in topics}
    for item in topics:
        if item.parent_id in children:
            children[item.parent_id].append(item.id)

    def path(topic: Category) -> str:
        names = [topic.name]
        seen = {topic.id}
        while topic.parent_id and topic.parent_id in by_id and topic.parent_id not in seen:
            topic = by_id[topic.parent_id]
            names.append(topic.name)
            seen.add(topic.id)
        return " / ".join(reversed(names))

    return {item.id: path(item) for item in topics}, children


def _root_topics(topics: dict[int, Category]) -> dict[int, Category]:
    roots: dict[int, Category] = {}
    for topic_id, topic in topics.items():
        seen = {topic_id}
        while topic.parent_id and topic.parent_id in topics and topic.parent_id not in seen:
            topic = topics[topic.parent_id]
            seen.add(topic.id)
        roots[topic_id] = topic
    return roots


def _is_descendant(db: Session, candidate_id: int | None, topic_id: int) -> bool:
    while candidate_id:
        if candidate_id == topic_id:
            return True
        parent = db.get(Category, candidate_id)
        candidate_id = parent.parent_id if parent else None
    return False


def _topic_payload(db: Session) -> tuple[list[Category], list[dict[str, object]]]:
    topics = list(db.scalars(select(Category).order_by(Category.name)))
    paths, children = _topic_paths(topics)
    return topics, [
        {
            "id": topic.id,
            "name": topic.name,
            "parent_id": topic.parent_id,
            "path": paths[topic.id],
            "is_leaf": not children[topic.id],
        }
        for topic in topics
    ]


@app.get("/api/topics")
def topic_tree(db: DatabaseSession) -> dict[str, object]:
    topics, flat = _topic_payload(db)
    direct: dict[int, Decimal] = defaultdict(Decimal)
    counts: dict[int, int] = defaultdict(int)
    for category_id, amount in db.execute(
        select(Transaction.category_id, Transaction.amount).where(Transaction.status != "excluded")
    ):
        if category_id:
            direct[category_id] += -amount
            counts[category_id] += 1
    children_by_parent: dict[int | None, list[Category]] = defaultdict(list)
    for topic in topics:
        children_by_parent[topic.parent_id].append(topic)

    def node(topic: Category) -> dict[str, object]:
        children = [node(child) for child in children_by_parent[topic.id]]
        return {
            "id": topic.id,
            "name": topic.name,
            "color": topic.color,
            "parent_id": topic.parent_id,
            "direct_spend": float(direct[topic.id]),
            "total_spend": float(direct[topic.id])
            + sum(child["total_spend"] for child in children),
            "transaction_count": counts[topic.id]
            + sum(child["transaction_count"] for child in children),
            "children": children,
        }

    return {"tree": [node(topic) for topic in children_by_parent[None]], "flat": flat}


@app.post("/api/topics")
def create_topic(request: TopicCreate, db: DatabaseSession) -> dict[str, object]:
    name = request.name.strip()
    if not name:
        raise HTTPException(400, "A topic name is required")
    if db.scalar(select(Category).where(func.lower(Category.name) == name.lower())):
        raise HTTPException(409, "A topic with this name already exists")
    if request.parent_id and not db.get(Category, request.parent_id):
        raise HTTPException(404, "Parent topic not found")
    topic = Category(name=name, color="#6F7FC7", parent_id=request.parent_id)
    db.add(topic)
    db.commit()
    db.refresh(topic)
    return {"topic_id": topic.id, "topic_name": topic.name}


@app.post("/api/topics/proposals")
def propose_topic(request: TopicProposalRequest, db: DatabaseSession) -> dict[str, object]:
    instructions = request.instructions.strip()
    if not instructions:
        raise HTTPException(400, "Explain what topic you need")
    _, topics = _topic_payload(db)
    suggestion = suggest_topic(instructions, topics)
    if not suggestion:
        raise HTTPException(
            503, "Codex could not create a suggestion. Check its login and try again"
        )
    proposal = TopicProposal(
        action=suggestion.action,
        new_name=suggestion.name,
        suggested_parent_id=suggestion.parent_id,
        merge_target_id=suggestion.merge_target_id,
        moves_json=json.dumps(suggestion.moves),
        reason=suggestion.reason,
    )
    db.add(proposal)
    db.commit()
    db.refresh(proposal)
    return _serialize_proposal(proposal, db)


@app.post("/api/topics/proposals/{proposal_id}/apply")
def apply_topic_proposal(proposal_id: int, db: DatabaseSession) -> dict[str, object]:
    proposal = db.get(TopicProposal, proposal_id)
    if not proposal or proposal.status != "pending":
        raise HTTPException(404, "Pending suggestion not found")
    if proposal.action == "merge":
        topic = db.get(Category, proposal.merge_target_id)
        if not topic:
            raise HTTPException(400, "The suggested topic no longer exists")
    else:
        if db.scalar(
            select(Category).where(func.lower(Category.name) == proposal.new_name.lower())
        ):
            raise HTTPException(409, "A topic with this name already exists")
        if proposal.suggested_parent_id and not db.get(Category, proposal.suggested_parent_id):
            raise HTTPException(400, "The suggested parent no longer exists")
        topic = Category(
            name=proposal.new_name,
            color="#6F7FC7",
            parent_id=proposal.suggested_parent_id,
        )
        db.add(topic)
        db.flush()
        for move in json.loads(proposal.moves_json):
            _move_topic(db, move["topic_id"], move["new_parent_id"])
    proposal.status = "applied"
    db.commit()
    return {"topic_id": topic.id, "topic_name": topic.name}


@app.post("/api/topics/proposals/{proposal_id}/reject")
def reject_topic_proposal(proposal_id: int, db: DatabaseSession) -> dict[str, str]:
    proposal = db.get(TopicProposal, proposal_id)
    if not proposal or proposal.status != "pending":
        raise HTTPException(404, "Pending suggestion not found")
    proposal.status = "rejected"
    db.commit()
    return {"status": "rejected"}


@app.put("/api/topics/{topic_id}")
def update_topic(topic_id: int, request: TopicUpdate, db: DatabaseSession) -> dict[str, str]:
    topic = db.get(Category, topic_id)
    if not topic:
        raise HTTPException(404, "Topic not found")
    duplicate = db.scalar(
        select(Category).where(
            func.lower(Category.name) == request.name.strip().lower(), Category.id != topic_id
        )
    )
    if duplicate:
        raise HTTPException(409, "A topic with this name already exists")
    _move_topic(db, topic_id, request.parent_id)
    topic.name = request.name.strip()
    db.commit()
    return {"status": "updated"}


@app.post("/api/topics/{topic_id}/merge")
def merge_topic(topic_id: int, request: TopicMerge, db: DatabaseSession) -> dict[str, str]:
    source = db.get(Category, topic_id)
    target = db.get(Category, request.target_id)
    if not source or not target or source.id == target.id:
        raise HTTPException(400, "Choose two different existing topics")
    if _is_descendant(db, target.id, source.id):
        raise HTTPException(400, "A topic cannot be merged into its descendant")
    db.execute(
        update(Transaction)
        .where(Transaction.category_id == source.id)
        .values(category_id=target.id)
    )
    db.execute(
        update(Transaction)
        .where(Transaction.proposed_category_id == source.id)
        .values(proposed_category_id=target.id)
    )
    db.execute(
        update(MerchantRule)
        .where(MerchantRule.category_id == source.id)
        .values(category_id=target.id)
    )
    _replace_tag_category(db, source.id, target.id)
    db.execute(update(Category).where(Category.parent_id == source.id).values(parent_id=target.id))
    db.delete(source)
    db.commit()
    return {"status": "merged"}


@app.delete("/api/topics/{topic_id}")
def delete_topic(topic_id: int, db: DatabaseSession) -> dict[str, str]:
    topic = db.get(Category, topic_id)
    if not topic:
        raise HTTPException(404, "Topic not found")
    if not topic.parent_id:
        raise HTTPException(400, "Root topics must be merged instead of deleted")
    db.execute(
        update(Transaction)
        .where(Transaction.category_id == topic.id)
        .values(category_id=topic.parent_id)
    )
    db.execute(
        update(Transaction)
        .where(Transaction.proposed_category_id == topic.id)
        .values(proposed_category_id=topic.parent_id)
    )
    db.execute(
        update(MerchantRule)
        .where(MerchantRule.category_id == topic.id)
        .values(category_id=topic.parent_id)
    )
    _replace_tag_category(db, topic.id, topic.parent_id)
    db.execute(
        update(Category).where(Category.parent_id == topic.id).values(parent_id=topic.parent_id)
    )
    db.delete(topic)
    db.commit()
    return {"status": "deleted"}


def _move_topic(db: Session, topic_id: int, parent_id: int | None) -> None:
    topic = db.get(Category, topic_id)
    if not topic or (parent_id and not db.get(Category, parent_id)):
        raise HTTPException(404, "Topic or parent not found")
    if _is_descendant(db, parent_id, topic_id):
        raise HTTPException(400, "A topic cannot be moved below itself")
    topic.parent_id = parent_id


def _replace_tag_category(db: Session, source_id: int, target_id: int) -> None:
    db.execute(
        delete(TransactionTag).where(
            TransactionTag.category_id == target_id,
            TransactionTag.transaction_id.in_(
                select(Transaction.id).where(Transaction.category_id == target_id)
            ),
        )
    )
    db.execute(
        delete(ProposedTransactionTag).where(
            ProposedTransactionTag.category_id == target_id,
            ProposedTransactionTag.transaction_id.in_(
                select(Transaction.id).where(Transaction.proposed_category_id == target_id)
            ),
        )
    )
    db.execute(
        delete(MerchantTagRule).where(
            MerchantTagRule.category_id == target_id,
            MerchantTagRule.merchant.in_(
                select(MerchantRule.merchant).where(MerchantRule.category_id == target_id)
            ),
        )
    )
    for row in list(
        db.scalars(select(TransactionTag).where(TransactionTag.category_id == source_id))
    ):
        target_exists = db.scalar(
            select(TransactionTag).where(
                TransactionTag.transaction_id == row.transaction_id,
                TransactionTag.category_id == target_id,
            )
        )
        primary_id = db.scalar(
            select(Transaction.category_id).where(Transaction.id == row.transaction_id)
        )
        if target_exists or primary_id == target_id:
            db.delete(row)
        else:
            row.category_id = target_id
    for row in list(
        db.scalars(
            select(ProposedTransactionTag).where(ProposedTransactionTag.category_id == source_id)
        )
    ):
        target_exists = db.scalar(
            select(ProposedTransactionTag).where(
                ProposedTransactionTag.transaction_id == row.transaction_id,
                ProposedTransactionTag.category_id == target_id,
            )
        )
        primary_id = db.scalar(
            select(Transaction.proposed_category_id).where(Transaction.id == row.transaction_id)
        )
        if target_exists or primary_id == target_id:
            db.delete(row)
        else:
            row.category_id = target_id
    for row in list(
        db.scalars(select(MerchantTagRule).where(MerchantTagRule.category_id == source_id))
    ):
        target_exists = db.scalar(
            select(MerchantTagRule).where(
                MerchantTagRule.merchant == row.merchant,
                MerchantTagRule.category_id == target_id,
            )
        )
        primary_id = db.scalar(
            select(MerchantRule.category_id).where(MerchantRule.merchant == row.merchant)
        )
        if target_exists or primary_id == target_id:
            db.delete(row)
        else:
            row.category_id = target_id


def _serialize_proposal(proposal: TopicProposal, db: Session) -> dict[str, object]:
    names = {item.id: item.name for item in db.scalars(select(Category))}
    return {
        "id": proposal.id,
        "action": proposal.action,
        "new_name": proposal.new_name,
        "parent_id": proposal.suggested_parent_id,
        "parent_name": names.get(proposal.suggested_parent_id),
        "merge_target_id": proposal.merge_target_id,
        "merge_target_name": names.get(proposal.merge_target_id),
        "moves": [
            {
                **move,
                "topic_name": names.get(move["topic_id"]),
                "new_parent_name": names.get(move["new_parent_id"]),
            }
            for move in json.loads(proposal.moves_json)
        ],
        "reason": proposal.reason,
    }


@app.get("/api/review")
def review_queue(db: DatabaseSession) -> list[dict[str, object]]:
    categories_by_id = {item.id: item for item in db.scalars(select(Category))}
    items = db.scalars(
        select(Transaction)
        .where(Transaction.status == "pending")
        .order_by(Transaction.operation_date.desc())
    )
    return [_serialize_transaction(item, categories_by_id) for item in items]


@app.post("/api/review/classify")
def classify_review_queue(
    db: DatabaseSession, request: ReviewClassificationRequest | None = None
) -> dict[str, int]:
    query = select(Transaction).where(Transaction.status == "pending")
    if request:
        query = query.where(Transaction.id.in_(request.transaction_ids))
    items = list(db.scalars(query.order_by(Transaction.id)))
    topics = list(db.scalars(select(Category)))
    categories_by_name = {item.name: item for item in topics}
    categories_by_id = {item.id: item for item in topics}
    rule_hints = _merchant_rule_hints(db, categories_by_id)
    inferred = classify_transactions(
        [
            {
                "key": str(item.id),
                "date": item.operation_date.isoformat(),
                "merchant": item.merchant,
                "bank_description": item.description,
                "amount_eur": float(item.amount),
            }
            for item in items
        ],
        list(categories_by_name),
        rule_hints,
    )
    if items and not inferred:
        raise HTTPException(503, "Codex could not prepare proposals. Check its login and try again")
    for item in items:
        result = inferred.get(str(item.id))
        if not result:
            continue
        item.ai_description = result.summary
        item.proposed_category_id = categories_by_name[result.category].id
        db.execute(
            delete(ProposedTransactionTag).where(ProposedTransactionTag.transaction_id == item.id)
        )
        db.add_all(
            ProposedTransactionTag(
                transaction_id=item.id,
                category_id=categories_by_name[name].id,
            )
            for name in result.additional_categories
        )
        item.confidence = result.confidence
        item.classification_source = "codex"
    db.commit()
    return {"updated": len(inferred), "processed": len(items)}


@app.post("/api/review/approve")
def approve_review_queue(request: ReviewApprovalRequest, db: DatabaseSession) -> dict[str, int]:
    transaction_ids = [item.transaction_id for item in request.items]
    if len(transaction_ids) != len(set(transaction_ids)):
        raise HTTPException(400, "Each transaction can only be approved once")
    transactions = {
        item.id: item
        for item in db.scalars(
            select(Transaction).where(
                Transaction.id.in_(transaction_ids), Transaction.status == "pending"
            )
        )
    }
    if len(transactions) != len(transaction_ids):
        raise HTTPException(404, "One or more pending transactions were not found")
    topic_ids = set(db.scalars(select(Category.id)))
    for item in request.items:
        _validate_topic_selection(item.category_id, item.additional_category_ids, topic_ids)
    rules = {item.merchant: item for item in db.scalars(select(MerchantRule))}
    merchant_tags: dict[str, set[int]] = {}
    for approval in request.items:
        transaction = transactions[approval.transaction_id]
        transaction.ai_description = approval.description.strip()
        if "transaction_label" in approval.model_fields_set:
            _set_transaction_label(transaction, approval.transaction_label)
        transaction.category_id = approval.category_id
        transaction.proposed_category_id = approval.category_id
        transaction.status = "confirmed"
        transaction.classification_source = "approved"
        db.execute(delete(TransactionTag).where(TransactionTag.transaction_id == transaction.id))
        db.add_all(
            TransactionTag(transaction_id=transaction.id, category_id=category_id)
            for category_id in approval.additional_category_ids
        )
        db.execute(
            delete(ProposedTransactionTag).where(
                ProposedTransactionTag.transaction_id == transaction.id
            )
        )
        merchant_tags[transaction.merchant] = set(approval.additional_category_ids)
        rule = rules.get(transaction.merchant)
        if rule:
            rule.category_id = approval.category_id
        else:
            rule = MerchantRule(merchant=transaction.merchant, category_id=approval.category_id)
            db.add(rule)
            rules[transaction.merchant] = rule
    for merchant, category_ids in merchant_tags.items():
        db.execute(delete(MerchantTagRule).where(MerchantTagRule.merchant == merchant))
        db.add_all(
            MerchantTagRule(merchant=merchant, category_id=category_id)
            for category_id in category_ids
        )
    db.commit()
    return {"approved": len(request.items)}


def _validate_topic_selection(
    category_id: int, additional_category_ids: list[int], topic_ids: set[int]
) -> None:
    additional = set(additional_category_ids)
    if (
        category_id not in topic_ids
        or len(additional) != len(additional_category_ids)
        or category_id in additional
        or not additional.issubset(topic_ids)
    ):
        raise HTTPException(
            400,
            "Every transaction needs one primary topic and unique additional topics",
        )


def _set_transaction_label(transaction: Transaction, label: str | None) -> None:
    normalized = (label or "").strip() or None
    if normalized == transaction.transaction_label:
        return
    transaction.transaction_label = normalized
    transaction.label_updated_at = datetime.now(UTC) if normalized else None


@app.get("/api/transaction-labels/recent")
def recent_transaction_labels(db: DatabaseSession) -> list[str]:
    return list(
        db.scalars(
            select(Transaction.transaction_label)
            .where(Transaction.transaction_label.is_not(None))
            .group_by(Transaction.transaction_label)
            .order_by(func.max(Transaction.label_updated_at).desc(), Transaction.transaction_label)
            .limit(6)
        )
    )


@app.get("/api/transactions")
def transactions(
    db: DatabaseSession,
    start_date: date | None = None,
    end_date: date | None = None,
    topic_id: int | None = None,
    name: str | None = None,
) -> list[dict[str, object]]:
    if start_date and end_date and start_date > end_date:
        raise HTTPException(400, "The start date must be before the end date")

    categories_by_id = {item.id: item for item in db.scalars(select(Category))}
    query = select(Transaction)
    if start_date:
        query = query.where(Transaction.operation_date >= start_date)
    if end_date:
        query = query.where(Transaction.operation_date <= end_date)
    if topic_id is not None:
        if topic_id not in categories_by_id:
            raise HTTPException(404, "Topic not found")
        topic_ids = {
            category_id
            for category_id in categories_by_id
            if category_id == topic_id
            or _is_topic_descendant(category_id, topic_id, categories_by_id)
        }
        tagged_transactions = select(TransactionTag.transaction_id).where(
            TransactionTag.category_id.in_(topic_ids)
        )
        proposed_tagged_transactions = select(ProposedTransactionTag.transaction_id).where(
            ProposedTransactionTag.category_id.in_(topic_ids)
        )
        query = query.where(
            or_(
                Transaction.category_id.in_(topic_ids),
                Transaction.proposed_category_id.in_(topic_ids),
                Transaction.id.in_(tagged_transactions),
                Transaction.id.in_(proposed_tagged_transactions),
            )
        )
    if search := (name or "").strip():
        pattern = f"%{search}%"
        query = query.where(
            Transaction.merchant.ilike(pattern)
            | Transaction.description.ilike(pattern)
            | Transaction.ai_description.ilike(pattern)
        )

    items = db.scalars(query.order_by(Transaction.operation_date.desc(), Transaction.id.desc()))
    return [_serialize_transaction(item, categories_by_id) for item in items]


@app.patch("/api/transactions/{transaction_id}/topics")
def update_transaction_topics(
    transaction_id: int, request: TransactionTopicsUpdate, db: DatabaseSession
) -> dict[str, object]:
    transaction = db.get(Transaction, transaction_id)
    if not transaction:
        raise HTTPException(404, "Transaction not found")
    if transaction.status == "excluded":
        raise HTTPException(400, "Excluded transactions cannot be categorized")

    categories = {item.id: item for item in db.scalars(select(Category))}
    _validate_topic_selection(request.category_id, request.additional_category_ids, set(categories))
    transaction.ai_description = request.description.strip()
    if "transaction_label" in request.model_fields_set:
        _set_transaction_label(transaction, request.transaction_label)
    transaction.category_id = request.category_id
    transaction.proposed_category_id = request.category_id
    transaction.status = "confirmed"
    transaction.classification_source = "edited"
    db.execute(delete(TransactionTag).where(TransactionTag.transaction_id == transaction.id))
    db.add_all(
        TransactionTag(transaction_id=transaction.id, category_id=category_id)
        for category_id in request.additional_category_ids
    )
    db.execute(
        delete(ProposedTransactionTag).where(
            ProposedTransactionTag.transaction_id == transaction.id
        )
    )

    rule = db.scalar(select(MerchantRule).where(MerchantRule.merchant == transaction.merchant))
    if rule:
        rule.category_id = request.category_id
    else:
        db.add(MerchantRule(merchant=transaction.merchant, category_id=request.category_id))
    db.execute(delete(MerchantTagRule).where(MerchantTagRule.merchant == transaction.merchant))
    db.add_all(
        MerchantTagRule(merchant=transaction.merchant, category_id=category_id)
        for category_id in request.additional_category_ids
    )
    db.commit()
    db.refresh(transaction)
    return _serialize_transaction(transaction, categories)


@app.patch("/api/transactions/{transaction_id}/exclusion")
def update_transaction_exclusion(
    transaction_id: int, request: TransactionExclusionUpdate, db: DatabaseSession
) -> dict[str, object]:
    transaction = db.get(Transaction, transaction_id)
    if not transaction:
        raise HTTPException(404, "Transaction not found")
    if not request.excluded and transaction.exclusion_reason != "manual":
        raise HTTPException(400, "Only manually excluded transactions can be restored")

    if request.excluded:
        transaction.status = "excluded"
        transaction.classification_source = "manual_exclusion"
        transaction.exclusion_reason = "manual"
    else:
        transaction.status = "confirmed" if transaction.category_id else "pending"
        transaction.classification_source = (
            "edited"
            if transaction.category_id
            else "codex"
            if transaction.proposed_category_id
            else "unclassified"
        )
        transaction.exclusion_reason = None
    db.commit()
    db.refresh(transaction)
    categories = {item.id: item for item in db.scalars(select(Category))}
    return _serialize_transaction(transaction, categories)


def _is_topic_descendant(candidate_id: int, topic_id: int, categories: dict[int, Category]) -> bool:
    seen = {candidate_id}
    parent_id = categories[candidate_id].parent_id
    while parent_id and parent_id in categories and parent_id not in seen:
        if parent_id == topic_id:
            return True
        seen.add(parent_id)
        parent_id = categories[parent_id].parent_id
    return False


def _serialize_transaction(item: Transaction, categories: dict[int, Category]) -> dict[str, object]:
    category = categories.get(item.category_id) if item.category_id else None
    proposed = categories.get(item.proposed_category_id) if item.proposed_category_id else None
    paths, _ = _topic_paths(list(categories.values()))
    return {
        "id": item.id,
        "date": item.operation_date.isoformat(),
        "description": item.description,
        "ai_description": item.ai_description,
        "transaction_label": item.transaction_label,
        "merchant": item.merchant,
        "amount": float(item.amount),
        "category": category.name if category else None,
        "category_id": category.id if category else None,
        "category_color": (category or proposed).color if category or proposed else "#D5D9E2",
        "proposed_category_id": proposed.id if proposed else None,
        "proposed_category": proposed.name if proposed else None,
        "proposed_category_path": paths[proposed.id] if proposed else None,
        "additional_categories": [
            {"id": tag.id, "name": tag.name, "path": paths[tag.id], "color": tag.color}
            for tag in item.tags
        ],
        "proposed_additional_categories": [
            {"id": tag.id, "name": tag.name, "path": paths[tag.id], "color": tag.color}
            for tag in item.proposed_tags
        ],
        "status": item.status,
        "confidence": item.confidence,
        "exclusion_reason": item.exclusion_reason,
    }
