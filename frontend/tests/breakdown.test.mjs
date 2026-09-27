import assert from "node:assert/strict";
import test from "node:test";
import { crossGroupBreakdowns, matchesBreakdownSelection, transactionGroupKey } from "../src/breakdown.ts";

const topics = new Map([
  [1, { id: 1, name: "Travel", parent_id: null }],
  [2, { id: 2, name: "Transport", parent_id: 1 }],
  [3, { id: 3, name: "Home", parent_id: null }],
]);

const transactions = [
  { amount: -100, category_id: 2, transaction_label: "Trip" },
  { amount: 20, category_id: 2, transaction_label: "Trip" },
  { amount: -30, category_id: 2, transaction_label: null },
  { amount: -40, category_id: 3, transaction_label: "Trip" },
  { amount: -10, category_id: null, transaction_label: null },
];

test("topic selections group net transaction amounts by label", () => {
  const result = crossGroupBreakdowns(transactions, "topic", topics);
  assert.deepEqual(result.get("Travel"), [
    { key: "label:Trip", name: "Trip", value: 80 },
    { key: "unlabeled", name: "Unlabeled", value: 30 },
  ]);
  assert.deepEqual(result.get("Pending review"), [
    { key: "unlabeled", name: "Unlabeled", value: 10 },
  ]);
  assert.equal(transactionGroupKey(transactions[0], "topic", topics), "Travel");
});

test("label selections group the same transactions by root topic", () => {
  const result = crossGroupBreakdowns(transactions, "label", topics);
  assert.deepEqual(result.get("label:Trip"), [
    { key: "Travel", name: "Travel", value: 80 },
    { key: "Home", name: "Home", value: 40 },
  ]);
  assert.deepEqual(result.get("unlabeled"), [
    { key: "Travel", name: "Travel", value: 30 },
    { key: "Pending review", name: "Pending review", value: 10 },
  ]);
});

test("a subgroup selects only transactions matching its parent and child", () => {
  const topicMatches = transactions.filter((item) => matchesBreakdownSelection(
    item, "topic", topics, new Set(["Travel"]), new Map([["Travel", new Set(["label:Trip"])]]),
  ));
  assert.deepEqual(topicMatches, transactions.slice(0, 2));

  const labelMatches = transactions.filter((item) => matchesBreakdownSelection(
    item, "label", topics, new Set(["label:Trip"]), new Map([["label:Trip", new Set(["Travel"])]]),
  ));
  assert.deepEqual(labelMatches, transactions.slice(0, 2));
});

test("other selected parents retain their own subgroup choices", () => {
  const selected = new Set(["Travel", "Home"]);
  const narrowed = new Map([["Travel", new Set(["label:Trip"])]]);
  const matches = transactions.filter((item) => matchesBreakdownSelection(item, "topic", topics, selected, narrowed));
  assert.deepEqual(matches, [transactions[0], transactions[1], transactions[3]]);
  assert.equal(matchesBreakdownSelection(transactions[2], "topic", topics, selected, new Map()), true);
});
