export type Category = {
  id: number;
  name: string;
  color: string;
  parent_id: number | null;
  path: string;
  is_leaf: boolean;
};

export type TopicNode = {
  id: number;
  name: string;
  color: string;
  parent_id: number | null;
  direct_spend: number;
  total_spend: number;
  transaction_count: number;
  children: TopicNode[];
};

export type TopicProposal = {
  id: number;
  action: "place" | "merge" | "restructure";
  new_name: string;
  parent_id: number | null;
  parent_name: string | null;
  merge_target_id: number | null;
  merge_target_name: string | null;
  moves: { topic_id: number; topic_name: string; new_parent_id: number | null; new_parent_name: string | null }[];
  reason: string;
};

export type Transaction = {
  id: number;
  date: string;
  description: string;
  ai_description: string | null;
  merchant: string;
  amount: number;
  category: string | null;
  category_id: number | null;
  category_color: string;
  proposed_category_id: number | null;
  proposed_category: string | null;
  proposed_category_path: string | null;
  additional_categories: { id: number; name: string; path: string; color: string }[];
  proposed_additional_categories: { id: number; name: string; path: string; color: string }[];
  status: string;
  confidence: number | null;
  exclusion_reason: string | null;
};

export type DashboardData = {
  period: string;
  range_start: string;
  range_end: string;
  is_custom: boolean;
  available_periods: string[];
  total: number;
  change: number | null;
  average: number;
  count: number;
  expense_count: number;
  credit_count: number;
  pending: number;
  categories: { name: string; value: number; color: string }[];
  monthly: Record<string, string | number>[];
  recent: Transaction[];
  transactions: Transaction[];
};

export type CoverageData = {
  start: string | null;
  end: string | null;
  gaps: { start: string; end: string; days: number }[];
};
