import type { Category, Transaction } from "./types";

export type BreakdownMode = "topic" | "label";
export type BreakdownGroup = { key: string; name: string; value: number };

type GroupTransaction = Pick<Transaction, "amount" | "category_id" | "transaction_label">;
type GroupTopic = Pick<Category, "id" | "name" | "parent_id">;

export const unlabeledKey = "unlabeled";
export const labelKey = (label: string | null): string => label ? `label:${label}` : unlabeledKey;
export const labelName = (key: string): string => key === unlabeledKey ? "Unlabeled" : key.slice(6);

export function transactionGroupKey(
  transaction: GroupTransaction,
  mode: BreakdownMode,
  topicsById: Map<number, GroupTopic>,
): string {
  if (mode === "label") return labelKey(transaction.transaction_label);
  let topic = transaction.category_id === null ? undefined : topicsById.get(transaction.category_id);
  while (topic?.parent_id) topic = topicsById.get(topic.parent_id);
  return topic?.name ?? "Pending review";
}

export function matchesBreakdownSelection(
  transaction: GroupTransaction,
  mode: BreakdownMode,
  topicsById: Map<number, GroupTopic>,
  selectedGroups: ReadonlySet<string>,
  selectedSubgroups: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (!selectedGroups.size) return true;
  const group = transactionGroupKey(transaction, mode, topicsById);
  if (!selectedGroups.has(group)) return false;
  const subgroups = selectedSubgroups.get(group);
  return !subgroups?.size || subgroups.has(transactionGroupKey(transaction, mode === "topic" ? "label" : "topic", topicsById));
}

export function crossGroupBreakdowns(
  transactions: GroupTransaction[],
  mode: BreakdownMode,
  topicsById: Map<number, GroupTopic>,
): Map<string, BreakdownGroup[]> {
  const totals = new Map<string, Map<string, number>>();
  const otherMode = mode === "topic" ? "label" : "topic";
  for (const transaction of transactions) {
    const group = transactionGroupKey(transaction, mode, topicsById);
    const other = transactionGroupKey(transaction, otherMode, topicsById);
    const children = totals.get(group) ?? new Map<string, number>();
    totals.set(group, children);
    children.set(other, (children.get(other) ?? 0) - transaction.amount);
  }
  return new Map([...totals].map(([key, children]) => [key, [...children].map(([childKey, value]) => ({
    key: childKey,
    name: otherMode === "label" ? labelName(childKey) : childKey,
    value: Number(value.toFixed(2)),
  })).sort((left, right) => right.value - left.value)]));
}
