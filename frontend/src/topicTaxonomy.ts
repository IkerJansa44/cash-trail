export type TaxonomyTopic = { id: number; name: string; parent_id: number | null };

export function taxonomyRows<T extends TaxonomyTopic>(topics: T[]) {
  const children = new Map<number | null, T[]>();
  topics.forEach((topic) => children.set(topic.parent_id, [...(children.get(topic.parent_id) ?? []), topic]));
  children.forEach((items) => items.sort((left, right) => left.name.localeCompare(right.name)));
  const rows: { topic: T; depth: number }[] = [];
  const seen = new Set<number>();
  const visit = (parentId: number | null, depth: number) => (children.get(parentId) ?? []).forEach((topic) => {
    if (seen.has(topic.id)) return;
    seen.add(topic.id);
    rows.push({ topic, depth });
    visit(topic.id, depth + 1);
  });
  visit(null, 0);
  topics.filter((topic) => !seen.has(topic.id)).forEach((topic) => rows.push({ topic, depth: 0 }));
  return rows;
}

export const topicLabel = (name: string, depth: number) => `${"\u00a0\u00a0\u00a0".repeat(depth)}${name}`;
