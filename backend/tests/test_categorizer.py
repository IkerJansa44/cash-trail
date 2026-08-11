from app import categorizer


def test_classifies_each_transaction_with_summary_topic_and_confidence(monkeypatch) -> None:
    call = {}

    def fake_codex(prompt, _schema, live_search=False):
        call["prompt"] = prompt
        call["live_search"] = live_search
        return {
            "classifications": [
                {
                    "key": "one",
                    "summary": "A monthly gym membership payment.",
                    "category": "Sports",
                    "additional_categories": ["Travel"],
                    "confidence": 0.94,
                },
                {
                    "key": "two",
                    "summary": "Dinner purchased at a restaurant.",
                    "category": "Dining",
                    "additional_categories": [],
                    "confidence": 0.83,
                },
            ]
        }

    monkeypatch.setattr(
        categorizer,
        "_run_codex",
        fake_codex,
    )

    result = categorizer.classify_transactions(
        [
            {"key": "one", "merchant": "GYM", "amount_eur": -40},
            {"key": "two", "merchant": "BISTRO", "amount_eur": -25},
        ],
        ["Sports", "Dining", "Travel"],
    )

    assert result["one"].summary == "A monthly gym membership payment."
    assert result["one"].category == "Sports"
    assert result["one"].additional_categories == ("Travel",)
    assert result["two"].confidence == 0.83
    assert call["live_search"] is True
    assert "Spanish or Catalan context" in call["prompt"]
    assert "positive amounts are refunds or repayments" in call["prompt"]
    assert "exclusive accounting allocation" in call["prompt"]


def test_suggests_where_to_place_a_new_topic(monkeypatch) -> None:
    monkeypatch.setattr(
        categorizer,
        "_run_codex",
        lambda _prompt, _schema: {
            "action": "place",
            "name": "Climbing",
            "parent_id": 1,
            "merge_target_id": None,
            "moves": [],
            "reason": "Climbing is a sport.",
        },
    )

    result = categorizer.suggest_topic(
        "I need a separate topic for climbing and it belongs with sports.",
        [{"id": 1, "name": "Sports", "parent_id": None, "is_leaf": True}],
    )

    assert result is not None
    assert result.action == "place"
    assert result.parent_id == 1
    assert result.reason == "Climbing is a sport."
