import json
from datetime import date
from decimal import Decimal

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.categorizer import TransactionSuggestion
from app.database import Base
from app.main import (
    ReviewApprovalItem,
    ReviewApprovalRequest,
    ReviewClassificationRequest,
    TopicCreate,
    TopicMerge,
    TopicUpdate,
    TransactionExclusionUpdate,
    TransactionTopicsUpdate,
    _exclusion_reason,
    apply_topic_proposal,
    approve_review_queue,
    classify_review_queue,
    create_topic,
    dashboard,
    delete_topic,
    merge_topic,
    statement_coverage,
    topic_tree,
    transactions,
    update_topic,
    update_transaction_exclusion,
    update_transaction_topics,
)
from app.models import (
    Category,
    ImportBatch,
    MerchantRule,
    MerchantTagRule,
    StatementCoverage,
    TopicProposal,
    Transaction,
    TransactionTag,
)


def session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def test_creates_topic_exactly_under_selected_parent() -> None:
    db = session()
    parent = Category(name="Health & Wellbeing", color="#4E9B7A")
    db.add(parent)
    db.commit()

    result = create_topic(TopicCreate(name="  Sports clubs  ", parent_id=parent.id), db)

    topic = db.get(Category, result["topic_id"])
    assert topic is not None
    assert topic.name == "Sports clubs"
    assert topic.parent_id == parent.id


def test_applies_taxonomy_changes_and_returns_the_resulting_topic() -> None:
    db = session()
    sports = Category(name="Sports", color="#111111")
    misplaced = Category(name="Photography", color="#222222")
    db.add_all([sports, misplaced])
    db.flush()
    misplaced.parent_id = sports.id
    proposal = TopicProposal(
        action="restructure",
        new_name="Climbing",
        suggested_parent_id=sports.id,
        moves_json=json.dumps([{"topic_id": misplaced.id, "new_parent_id": None}]),
        reason="Keep sports together and move photography to the root.",
    )
    db.add(proposal)
    db.commit()

    result = apply_topic_proposal(proposal.id, db)

    topic = db.get(Category, result["topic_id"])
    db.refresh(misplaced)
    assert topic is not None
    assert topic.name == "Climbing"
    assert topic.parent_id == sports.id
    assert misplaced.parent_id is None


def test_finds_gaps_between_imported_statement_ranges() -> None:
    db = session()
    first = ImportBatch(filename="first.xls", imported_count=1, duplicate_count=0)
    second = ImportBatch(filename="second.xls", imported_count=1, duplicate_count=0)
    db.add_all([first, second])
    db.flush()
    db.add_all(
        [
            StatementCoverage(
                import_batch_id=first.id,
                start_date=date(2026, 8, 11),
                end_date=date(2026, 8, 16),
                source="queried_range",
            ),
            StatementCoverage(
                import_batch_id=second.id,
                start_date=date(2026, 8, 22),
                end_date=date(2026, 8, 30),
                source="queried_range",
            ),
        ]
    )
    db.commit()

    result = statement_coverage(db)

    assert result["gaps"] == [{"start": "2026-08-17", "end": "2026-08-21", "days": 5}]


def test_calculates_spending_for_inclusive_custom_range() -> None:
    db = session()
    category = Category(name="Dining", color="#E97852")
    batch = ImportBatch(filename="statement.xls", imported_count=2, duplicate_count=0)
    db.add_all([category, batch])
    db.flush()
    for index, (operation_date, amount) in enumerate(
        [(date(2026, 8, 10), "-10.00"), (date(2026, 8, 11), "-25.00")]
    ):
        db.add(
            Transaction(
                operation_date=operation_date,
                value_date=operation_date,
                description="RESTAURANT",
                merchant="RESTAURANT",
                amount=Decimal(amount),
                balance=None,
                currency="EUR",
                fingerprint=str(index),
                status="confirmed",
                classification_source="manual",
                category_id=category.id,
                import_batch_id=batch.id,
            )
        )
    db.commit()

    result = dashboard(db, start_date=date(2026, 8, 11), end_date=date(2026, 8, 11))

    assert result["total"] == 25.0
    assert result["count"] == 1
    assert result["is_custom"] is True
    assert len(result["transactions"]) == 1
    assert result["monthly"] == [{"month": "2026-08", "Dining": 25.0}]


def test_refund_can_create_a_negative_net_topic_total() -> None:
    db = session()
    category = Category(name="Travel", color="#3AA6B9")
    batch = ImportBatch(filename="statement.xls", imported_count=2, duplicate_count=0)
    db.add_all([category, batch])
    db.flush()
    for index, amount in enumerate(("-20.00", "35.00")):
        db.add(
            Transaction(
                operation_date=date(2026, 8, 11),
                description="TRAVEL REFUND" if index else "TRAVEL PURCHASE",
                merchant="TRAVEL MERCHANT",
                amount=Decimal(amount),
                currency="EUR",
                fingerprint=f"net-{index}",
                status="confirmed",
                classification_source="approved",
                category_id=category.id,
                import_batch_id=batch.id,
            )
        )
    db.commit()

    result = dashboard(db, start_date=date(2026, 8, 11), end_date=date(2026, 8, 11))

    assert result["total"] == -15.0
    assert result["categories"] == [{"name": "Travel", "value": -15.0, "color": "#3AA6B9"}]
    assert result["expense_count"] == 1
    assert result["credit_count"] == 1
    assert topic_tree(db)["tree"][0]["total_spend"] == -15.0


def test_excludes_payroll_and_account_transfers_but_not_refunds() -> None:
    assert _exclusion_reason(Decimal("2337.19"), "NOMINA CTE DE:HP PRINTING") == "payroll"
    assert _exclusion_reason(Decimal("100.00"), "TRANSFERÈNCIA DE COMPTE PROPI") == "transfer"
    assert _exclusion_reason(Decimal("-100.00"), "TRASPÀS A COMPTE PROPI") == "transfer"
    assert _exclusion_reason(Decimal("39.00"), "BIZUM DE: MARTI SERRA MANS") is None


def test_filters_transactions_by_date_topic_and_name() -> None:
    db = session()
    subscriptions = Category(name="Subscriptions", color="#7B82E6")
    software = Category(name="Software", color="#7357D9", parent_id=None)
    dining = Category(name="Dining", color="#E97852")
    travel = Category(name="Travel", color="#3AA6B9")
    batch = ImportBatch(filename="statement.xls", imported_count=3, duplicate_count=0)
    db.add_all([subscriptions, dining, travel, batch])
    db.flush()
    software.parent_id = subscriptions.id
    db.add(software)
    db.flush()
    for index, (operation_date, merchant, category) in enumerate(
        [
            (date(2026, 7, 1), "MICROSOFT", software),
            (date(2026, 1, 1), "MICROSOFT", software),
            (date(2026, 7, 2), "CAFE", dining),
        ]
    ):
        db.add(
            Transaction(
                operation_date=operation_date,
                description=f"CARD PAYMENT {merchant}",
                merchant=merchant,
                amount=Decimal("-10.00"),
                currency="EUR",
                fingerprint=f"filter-{index}",
                status="confirmed",
                classification_source="manual",
                category_id=category.id,
                import_batch_id=batch.id,
            )
        )
    db.commit()
    cafe = db.scalar(select(Transaction).where(Transaction.merchant == "CAFE"))
    db.add(TransactionTag(transaction_id=cafe.id, category_id=travel.id))
    db.commit()

    result = transactions(
        db,
        start_date=date(2026, 5, 1),
        end_date=date(2026, 8, 1),
        topic_id=subscriptions.id,
        name="micro",
    )

    assert [item["merchant"] for item in result] == ["MICROSOFT"]
    assert result[0]["date"] == "2026-07-01"
    assert [item["merchant"] for item in transactions(db, topic_id=travel.id)] == ["CAFE"]


def test_rolls_leaf_spending_up_to_root_topic() -> None:
    db = session()
    root = Category(name="Health & Wellbeing", color="#4E9B7A")
    leaf = Category(name="Sports", color="#3A9B80")
    batch = ImportBatch(filename="statement.xls", imported_count=1, duplicate_count=0)
    db.add_all([root, batch])
    db.flush()
    leaf.parent_id = root.id
    db.add(leaf)
    db.flush()
    db.add(
        Transaction(
            operation_date=date(2026, 8, 11),
            description="GYM",
            merchant="GYM",
            amount=Decimal("-50.00"),
            balance=None,
            currency="EUR",
            fingerprint="sports",
            status="confirmed",
            classification_source="manual",
            category_id=leaf.id,
            import_batch_id=batch.id,
        )
    )
    db.commit()

    result = dashboard(db, start_date=date(2026, 8, 11), end_date=date(2026, 8, 11))

    assert result["categories"][0]["name"] == "Health & Wellbeing"
    assert result["categories"][0]["value"] == 50.0
    assert topic_tree(db)["tree"][0]["total_spend"] == 50.0


def test_moves_nested_topic_to_the_root() -> None:
    db = session()
    parent = Category(name="Health & Wellbeing", color="#4E9B7A")
    child = Category(name="Sports", color="#3A9B80")
    db.add(parent)
    db.flush()
    child.parent_id = parent.id
    db.add(child)
    db.commit()

    update_topic(child.id, TopicUpdate(name="Sports", parent_id=None), db)

    db.refresh(child)
    assert child.parent_id is None


def test_delete_moves_spending_and_children_to_parent() -> None:
    db = session()
    parent = Category(name="Parent", color="#111111")
    topic = Category(name="Topic", color="#222222")
    child = Category(name="Child", color="#333333")
    batch = ImportBatch(filename="statement.xls", imported_count=1, duplicate_count=0)
    db.add_all([parent, batch])
    db.flush()
    topic.parent_id = parent.id
    db.add(topic)
    db.flush()
    child.parent_id = topic.id
    db.add(child)
    db.flush()
    transaction = Transaction(
        operation_date=date(2026, 8, 11),
        description="SHOP",
        merchant="SHOP",
        amount=Decimal("-5.00"),
        balance=None,
        currency="EUR",
        fingerprint="delete",
        status="confirmed",
        classification_source="manual",
        category_id=topic.id,
        import_batch_id=batch.id,
    )
    db.add(transaction)
    db.commit()

    delete_topic(topic.id, db)

    db.refresh(transaction)
    db.refresh(child)
    assert transaction.category_id == parent.id
    assert child.parent_id == parent.id


def test_merge_moves_spending_and_children_to_target() -> None:
    db = session()
    source = Category(name="Running", color="#111111")
    target = Category(name="Sports", color="#222222")
    child = Category(name="Shoes", color="#333333")
    batch = ImportBatch(filename="statement.xls", imported_count=1, duplicate_count=0)
    db.add_all([source, target, batch])
    db.flush()
    child.parent_id = source.id
    db.add(child)
    db.flush()
    transaction = Transaction(
        operation_date=date(2026, 8, 11),
        description="RACE",
        merchant="RACE",
        amount=Decimal("-15.00"),
        balance=None,
        currency="EUR",
        fingerprint="merge",
        status="confirmed",
        classification_source="manual",
        category_id=source.id,
        import_batch_id=batch.id,
    )
    db.add(transaction)
    db.commit()

    merge_topic(source.id, TopicMerge(target_id=target.id), db)

    db.refresh(transaction)
    db.refresh(child)
    assert transaction.category_id == target.id
    assert child.parent_id == target.id


def test_approval_applies_edited_proposal_and_updates_dashboard() -> None:
    db = session()
    topic = Category(name="Dining", color="#E97852")
    context = Category(name="Friends", color="#7A68C7")
    batch = ImportBatch(filename="statement.xls", imported_count=1, duplicate_count=0)
    db.add_all([topic, context, batch])
    db.flush()
    db.add_all(
        [
            Category(name="Restaurants", color="#E97852", parent_id=topic.id),
            Category(name="Social events", color="#7A68C7", parent_id=context.id),
        ]
    )
    transaction = Transaction(
        operation_date=date(2026, 8, 11),
        description="TARGETA CAFE",
        merchant="CAFE",
        amount=Decimal("-8.50"),
        balance=None,
        currency="EUR",
        fingerprint="pending",
        status="pending",
        classification_source="codex",
        ai_description="A coffee purchase.",
        confidence=0.72,
        proposed_category_id=topic.id,
        import_batch_id=batch.id,
    )
    db.add(transaction)
    db.commit()

    pending = dashboard(db, start_date=date(2026, 8, 11), end_date=date(2026, 8, 11))
    assert pending["categories"][0]["name"] == "Pending review"

    result = approve_review_queue(
        ReviewApprovalRequest(
            items=[
                ReviewApprovalItem(
                    transaction_id=transaction.id,
                    description="Coffee with a friend.",
                    category_id=topic.id,
                    additional_category_ids=[context.id],
                )
            ]
        ),
        db,
    )

    db.refresh(transaction)
    assert result == {"approved": 1}
    assert transaction.status == "confirmed"
    assert transaction.ai_description == "Coffee with a friend."
    assert transaction.category_id == topic.id
    assert db.query(MerchantRule).one().category_id == topic.id
    assert db.query(TransactionTag).one().category_id == context.id
    assert db.query(MerchantTagRule).one().category_id == context.id
    approved = dashboard(db, start_date=date(2026, 8, 11), end_date=date(2026, 8, 11))
    assert approved["categories"][0]["name"] == "Dining"
    assert approved["total"] == 8.5


def test_classifies_only_the_requested_review_batch(monkeypatch) -> None:
    db = session()
    topic = Category(name="Dining", color="#E97852")
    batch = ImportBatch(filename="statement.xls", imported_count=2, duplicate_count=0)
    db.add_all([topic, batch])
    db.flush()
    transactions_to_review = [
        Transaction(
            operation_date=date(2026, 8, 11),
            description=merchant,
            merchant=merchant,
            amount=Decimal("-10.00"),
            currency="EUR",
            fingerprint=f"batch-{index}",
            status="pending",
            classification_source="unclassified",
            import_batch_id=batch.id,
        )
        for index, merchant in enumerate(("CAFE", "BISTRO"))
    ]
    db.add_all(transactions_to_review)
    db.commit()
    selected = transactions_to_review[1]

    def classify(items, _topics, _hints):
        assert [item["key"] for item in items] == [str(selected.id)]
        return {
            str(selected.id): TransactionSuggestion(
                "Dinner purchased at a restaurant.", "Dining", (), 0.91
            )
        }

    monkeypatch.setattr("app.main.classify_transactions", classify)

    result = classify_review_queue(db, ReviewClassificationRequest(transaction_ids=[selected.id]))

    db.refresh(selected)
    db.refresh(transactions_to_review[0])
    assert result == {"updated": 1, "processed": 1}
    assert selected.proposed_category_id == topic.id
    assert transactions_to_review[0].proposed_category_id is None


def test_edits_primary_and_context_topics_from_transactions() -> None:
    db = session()
    dining = Category(name="Dining", color="#E97852")
    travel = Category(name="Travel", color="#3AA6B9")
    batch = ImportBatch(filename="statement.xls", imported_count=1, duplicate_count=0)
    db.add_all([dining, travel, batch])
    db.flush()
    transaction = Transaction(
        operation_date=date(2026, 8, 11),
        description="TARGETA CAFE",
        merchant="CAFE",
        amount=Decimal("-8.50"),
        balance=None,
        currency="EUR",
        fingerprint="topic-edit",
        status="pending",
        classification_source="codex",
        import_batch_id=batch.id,
    )
    db.add(transaction)
    db.commit()

    updated = update_transaction_topics(
        transaction.id,
        TransactionTopicsUpdate(
            description="Coffee during a day trip.",
            category_id=dining.id,
            additional_category_ids=[travel.id],
        ),
        db,
    )

    db.refresh(transaction)
    assert updated["category_id"] == dining.id
    assert updated["additional_categories"][0]["id"] == travel.id
    assert transaction.status == "confirmed"
    assert transaction.classification_source == "edited"
    assert transaction.ai_description == "Coffee during a day trip."
    assert db.query(MerchantRule).one().category_id == dining.id
    assert db.query(MerchantTagRule).one().category_id == travel.id


def test_manually_excludes_and_restores_a_transaction() -> None:
    db = session()
    dining = Category(name="Dining", color="#E97852")
    batch = ImportBatch(filename="statement.xls", imported_count=1, duplicate_count=0)
    db.add_all([dining, batch])
    db.flush()
    transaction = Transaction(
        operation_date=date(2026, 8, 11),
        description="TARGETA CAFE",
        merchant="CAFE",
        amount=Decimal("-8.50"),
        currency="EUR",
        fingerprint="manual-exclusion",
        status="confirmed",
        classification_source="edited",
        category_id=dining.id,
        import_batch_id=batch.id,
    )
    db.add(transaction)
    db.commit()

    excluded = update_transaction_exclusion(
        transaction.id, TransactionExclusionUpdate(excluded=True), db
    )

    assert excluded["status"] == "excluded"
    assert excluded["exclusion_reason"] == "manual"
    assert dashboard(db, year=2026, month=8)["total"] == 0
    assert transactions(db)[0]["status"] == "excluded"

    restored = update_transaction_exclusion(
        transaction.id, TransactionExclusionUpdate(excluded=False), db
    )

    assert restored["status"] == "confirmed"
    assert restored["exclusion_reason"] is None
    assert dashboard(db, year=2026, month=8)["total"] == 8.5
