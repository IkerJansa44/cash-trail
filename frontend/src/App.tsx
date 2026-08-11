import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarRange,
  ChartNoAxesCombined,
  Check,
  CircleHelp,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  Plus,
  ReceiptText,
  Search,
  Sparkles,
  Tags,
  TriangleAlert,
  Upload,
  WalletCards,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiRequest } from "./api";
import { taxonomyRows, topicLabel } from "./topicTaxonomy";
import TopicsPage from "./Topics";
import type { Category, CoverageData, DashboardData, TopicProposal, Transaction } from "./types";

type View = "dashboard" | "transactions" | "review" | "topics";
const euro = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const compactEuro = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", notation: "compact" });
const monthLabel = (value: string) => new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(`${value}-01T00:00:00`));
const shortMonth = (value: string) => new Intl.DateTimeFormat("en", { month: "short" }).format(new Date(`${value}-01T00:00:00`));
const shortDate = (value: string) => new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
const signedEuro = (amount: number) => `${amount >= 0 ? "+" : "−"}${euro.format(Math.abs(amount))}`;

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [monthDetail, setMonthDetail] = useState<DashboardData | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [review, setReview] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [coverage, setCoverage] = useState<CoverageData | null>(null);
  const [period, setPeriod] = useState("");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [busy, setBusy] = useState(true);
  const [monthBusy, setMonthBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (selectedPeriod = period, customStart = "", customEnd = "") => {
    setBusy(true);
    try {
      const query = customStart && customEnd
        ? `?start_date=${customStart}&end_date=${customEnd}`
        : selectedPeriod ? `?year=${selectedPeriod.slice(0, 4)}&month=${Number(selectedPeriod.slice(5))}` : "";
      const [dashboardData, categoryData, coverageData] = await Promise.all([
        apiRequest<DashboardData>(`/api/dashboard${query}`),
        apiRequest<Category[]>("/api/categories"),
        apiRequest<CoverageData>("/api/coverage"),
      ]);
      setDashboard(dashboardData);
      setPeriod(dashboardData.period);
      setCategories(categoryData);
      setCoverage(coverageData);
      if (view === "transactions") setTransactions(await apiRequest<Transaction[]>("/api/transactions"));
      if (view === "review") setReview(await apiRequest<Transaction[]>("/api/review"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to load the dashboard");
    } finally {
      setBusy(false);
    }
  }, [period, view]);

  useEffect(() => void load(), [view]);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    setBusy(true);
    try {
      const result = await apiRequest<{ imported: number; duplicates: number; pending_review: number }>("/api/imports", { method: "POST", body: form });
      setNotice(`${result.imported} transactions imported · ${result.duplicates} duplicates skipped · ${result.pending_review} need review`);
      await load("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import failed");
    } finally {
      event.target.value = "";
      setBusy(false);
    }
  };

  const approveTransactions = async (items: { transaction_id: number; description: string; category_id: number }[]) => {
    const result = await apiRequest<{ approved: number }>("/api/review/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    setNotice(`${result.approved} ${result.approved === 1 ? "transaction" : "transactions"} approved · dashboards updated`);
    await load(period);
  };

  const classifyPending = async () => {
    setBusy(true);
    try {
      const result = await apiRequest<{ updated: number; remaining: number }>("/api/review/classify", { method: "POST" });
      setNotice(`Codex prepared ${result.updated} proposals · ${result.remaining} await your approval`);
      await load(period);
      setReview(await apiRequest<Transaction[]>("/api/review"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Codex classification failed");
    } finally {
      setBusy(false);
    }
  };

  const applyRange = () => {
    if (!rangeStart || !rangeEnd) {
      setNotice("Choose both a start and an end date");
      return;
    }
    void load(period, rangeStart, rangeEnd);
  };

  const clearRange = () => {
    setRangeStart("");
    setRangeEnd("");
    void load(period);
  };

  const loadMonthDetail = async (month: string) => {
    setMonthBusy(true);
    try {
      setMonthDetail(await apiRequest<DashboardData>(`/api/dashboard?year=${month.slice(0, 4)}&month=${Number(month.slice(5))}`));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to load month details");
    } finally {
      setMonthBusy(false);
    }
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">C</span><span>Cash Trail</span></div>
        <nav>
          <NavItem active={view === "dashboard"} icon={<LayoutDashboard />} label="Overview" onClick={() => setView("dashboard")} />
          <NavItem active={view === "transactions"} icon={<ReceiptText />} label="Transactions" onClick={() => setView("transactions")} />
          <NavItem active={view === "topics"} icon={<Tags />} label="Topics" onClick={() => setView("topics")} />
          <NavItem active={view === "review"} icon={<CircleHelp />} label="Review" badge={dashboard?.pending} onClick={() => setView("review")} />
        </nav>
        <div className="privacy-note"><WalletCards /><div><strong>Local by design</strong><span>Your financial data stays on this computer.</span></div></div>
      </aside>

      <main>
        <header>
          <div><p className="eyebrow">PERSONAL SPENDING</p><h1>{view === "dashboard" ? "Overview" : view === "transactions" ? "Transactions" : view === "topics" ? "Topics" : "Review classifications"}</h1></div>
          <div className="header-actions">
            <button className="import-button" onClick={() => fileInput.current?.click()} disabled={busy}><Upload />Import statement</button>
            <input ref={fileInput} type="file" accept=".xls,.xlsx" hidden onChange={importFile} />
          </div>
        </header>

        {notice && <div className="notice" onClick={() => setNotice("")}>{notice}<span>×</span></div>}
        {view === "dashboard" && dashboard?.available_periods.length ? <div className="range-bar"><div><CalendarRange /><strong>Custom spending range</strong></div><input aria-label="Range start" type="date" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} /><span>to</span><input aria-label="Range end" type="date" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} /><button onClick={applyRange} disabled={busy}>View range</button>{dashboard.is_custom && <button className="clear-range" onClick={clearRange}>Clear</button>}</div> : null}
        {coverage?.gaps.length ? <div className="coverage-alert"><TriangleAlert /><div><strong>Missing statement dates</strong><span>{coverage.gaps.map((gap) => `${shortDate(gap.start)}–${shortDate(gap.end)} (${gap.days} ${gap.days === 1 ? "day" : "days"})`).join(" · ")}</span></div></div> : null}
        {busy && !dashboard ? <EmptyState loading /> : view === "dashboard" ? <Dashboard data={dashboard} monthDetail={monthDetail} monthBusy={monthBusy} onMonthSelect={loadMonthDetail} onCloseMonth={() => setMonthDetail(null)} /> : view === "transactions" ? <TransactionList initialItems={transactions} categories={categories} /> : view === "topics" ? <TopicsPage /> : <ReviewQueue items={review} categories={categories} onApprove={approveTransactions} onClassify={classifyPending} onTopicsChanged={async () => setCategories(await apiRequest<Category[]>("/api/categories"))} busy={busy} />}
      </main>
    </div>
  );
}

function NavItem({ active, icon, label, badge, onClick }: { active: boolean; icon: React.ReactNode; label: string; badge?: number; onClick: () => void }) {
  return <button className={active ? "nav-item active" : "nav-item"} onClick={onClick}>{icon}<span>{label}</span>{badge ? <em>{badge}</em> : null}</button>;
}

function Dashboard({ data, monthDetail, monthBusy, onMonthSelect, onCloseMonth }: { data: DashboardData | null; monthDetail: DashboardData | null; monthBusy: boolean; onMonthSelect: (month: string) => Promise<void>; onCloseMonth: () => void }) {
  const categoryNames = useMemo(() => [...new Set(data?.monthly.flatMap((row) => Object.keys(row).filter((key) => key !== "month")) ?? [])], [data]);
  const colors = Object.fromEntries((data?.categories ?? []).map((item) => [item.name, item.color]));
  if (!data || !data.available_periods.length) return <EmptyState />;
  const positiveCategories = data.categories.filter((item) => item.value > 0);
  return (
    <div className="dashboard">
      <section className="kpi-grid">
        <Kpi label={data.is_custom ? "Net spent in range" : "Net spent this month"} value={euro.format(data.total)} detail={`${data.expense_count} expenses · ${data.credit_count} credits`} icon={<WalletCards />} />
        <Kpi label={data.is_custom ? "Previous equal period" : "Month over month"} value={data.change === null ? "—" : `${Math.abs(data.change).toFixed(1)}%`} detail={data.change === null ? "No preceding data" : data.change > 0 ? "More than before" : "Less than before"} icon={data.change !== null && data.change > 0 ? <ArrowUpRight /> : <ArrowDownRight />} tone={data.change !== null && data.change > 0 ? "warning" : "good"} />
        <Kpi label="Average net transaction" value={euro.format(data.average)} detail={data.is_custom ? `${shortDate(data.range_start)} – ${shortDate(data.range_end)}` : monthLabel(data.period)} icon={<ChartNoAxesCombined />} />
        <Kpi label="Needs review" value={String(data.pending)} detail={data.pending ? "Help improve future imports" : "Everything is categorized"} icon={data.pending ? <CircleHelp /> : <Check />} tone={data.pending ? "warning" : "good"} />
      </section>

      <section className="panel chart-panel">
        <div className="panel-heading"><div><p className="eyebrow">SPENDING HISTORY</p><h2>Net monthly spend by category</h2></div><span>{monthBusy ? "Loading month…" : "Click a month for details"}</span></div>
        <div className="bar-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.monthly} margin={{ top: 20, right: 8, left: -12, bottom: 0 }} barSize={34} onClick={(event) => { if (event?.activeLabel) void onMonthSelect(String(event.activeLabel)); }}>
              <CartesianGrid vertical={false} stroke="#e8e7e3" />
              <XAxis dataKey="month" tickFormatter={shortMonth} axisLine={false} tickLine={false} tick={{ fill: "#8b8f99", fontSize: 12 }} />
              <YAxis tickFormatter={(value) => compactEuro.format(value)} axisLine={false} tickLine={false} tick={{ fill: "#8b8f99", fontSize: 12 }} />
              <Tooltip cursor={{ fill: "#f6f5f2" }} formatter={(value) => euro.format(Number(value))} labelFormatter={(value) => monthLabel(String(value))} />
              {categoryNames.map((name) => <Bar key={name} dataKey={name} stackId="spend" fill={colors[name] || "#B2B8C5"} radius={[3, 3, 0, 0]} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="legend">{categoryNames.map((name) => <span key={name}><i style={{ background: colors[name] || "#B2B8C5" }} />{name}</span>)}</div>
      </section>

      {monthDetail && <MonthDetail data={monthDetail} onClose={onCloseMonth} />}

      <div className="lower-grid">
        <section className="panel category-panel">
          <div className="panel-heading"><div><p className="eyebrow">BREAKDOWN</p><h2>Net by category</h2></div></div>
          <div className="category-content">
            <div className="donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={positiveCategories} dataKey="value" innerRadius={60} outerRadius={82} paddingAngle={2}>{positiveCategories.map((item) => <Cell key={item.name} fill={item.color} />)}</Pie><Tooltip formatter={(value) => euro.format(Number(value))} /></PieChart></ResponsiveContainer><div><strong>{euro.format(data.total)}</strong><span>Net total</span></div></div>
            <div className="category-list">{data.categories.map((item) => <div key={item.name}><span><i style={{ background: item.color }} />{item.name}</span><strong className={item.value < 0 ? "net-credit" : ""}>{euro.format(item.value)}</strong></div>)}</div>
          </div>
        </section>
        <section className="panel recent-panel"><div className="panel-heading"><div><p className="eyebrow">ACTIVITY</p><h2>Recent transactions</h2></div></div><TransactionRows items={data.recent} /></section>
      </div>
    </div>
  );
}

function MonthDetail({ data, onClose }: { data: DashboardData; onClose: () => void }) {
  const categoryScale = Math.max(1, ...data.categories.map((category) => Math.abs(category.value)));
  return <section className="panel month-detail">
    <div className="month-detail-heading"><div><p className="eyebrow">MONTH DETAIL</p><h2>{monthLabel(data.period)}</h2></div><button aria-label="Close month details" onClick={onClose}>×</button></div>
    <div className="month-detail-stats"><div><span>Net spent</span><strong>{euro.format(data.total)}</strong></div><div><span>Activity</span><strong>{data.expense_count} expenses · {data.credit_count} credits</strong></div><div><span>Average net</span><strong>{euro.format(data.average)}</strong></div><div><span>Vs previous month</span><strong>{data.change === null ? "—" : `${data.change > 0 ? "+" : ""}${data.change.toFixed(1)}%`}</strong></div></div>
    <div className="month-detail-content"><div><h3>Net category breakdown</h3><div className="month-categories">{data.categories.map((category) => <div key={category.name}><span><i style={{ background: category.color }} />{category.name}</span><div><b style={{ width: `${Math.abs(category.value) / categoryScale * 100}%`, background: category.color }} /><strong className={category.value < 0 ? "net-credit" : ""}>{euro.format(category.value)}</strong></div></div>)}</div></div><div><h3>Transactions</h3><div className="month-transactions"><TransactionRows items={data.transactions} showStatus /></div></div></div>
  </section>;
}

function Kpi({ label, value, detail, icon, tone = "neutral" }: { label: string; value: string; detail: string; icon: React.ReactNode; tone?: string }) {
  return <div className="kpi"><div className={`kpi-icon ${tone}`}>{icon}</div><p>{label}</p><strong>{value}</strong><span>{detail}</span></div>;
}

function TransactionList({ initialItems, categories }: { initialItems: Transaction[]; categories: Category[] }) {
  const [items, setItems] = useState(initialItems);
  const [name, setName] = useState("");
  const [topicId, setTopicId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const topicRows = useMemo(() => taxonomyRows(categories), [categories]);

  useEffect(() => setItems(initialItems), [initialItems]);

  const applyFilters = async (overrides: { startDate?: string; endDate?: string } = {}) => {
    const start = overrides.startDate ?? startDate;
    const end = overrides.endDate ?? endDate;
    if (start && end && start > end) {
      setError("The start date must be before the end date");
      return;
    }
    const params = new URLSearchParams();
    if (name.trim()) params.set("name", name.trim());
    if (topicId) params.set("topic_id", topicId);
    if (start) params.set("start_date", start);
    if (end) params.set("end_date", end);
    setLoading(true);
    setError("");
    try {
      setItems(await apiRequest<Transaction[]>(`/api/transactions?${params}`));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to filter transactions");
    } finally {
      setLoading(false);
    }
  };

  const applyLastThreeMonths = () => {
    const end = new Date();
    const start = new Date(end);
    start.setMonth(start.getMonth() - 3);
    const dates = { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
    setStartDate(dates.startDate);
    setEndDate(dates.endDate);
    void applyFilters(dates);
  };

  const clearFilters = () => {
    setName("");
    setTopicId("");
    setStartDate("");
    setEndDate("");
    setError("");
    setLoading(true);
    void apiRequest<Transaction[]>("/api/transactions")
      .then(setItems)
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to load transactions"))
      .finally(() => setLoading(false));
  };

  const hasFilters = Boolean(name || topicId || startDate || endDate);
  return <div className="transactions-page">
    <section className="panel transaction-filters">
      <div className="filter-heading"><div><ListFilter /><div><strong>Filter transactions</strong><span>Combine any of the filters below</span></div></div><button type="button" className="date-shortcut" onClick={applyLastThreeMonths}>Last 3 months</button></div>
      <div className="filter-fields">
        <label className="name-filter"><span>Name</span><div><Search /><input aria-label="Transaction name" placeholder="e.g. Microsoft" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void applyFilters(); }} /></div></label>
        <label><span>Topic</span><select aria-label="Transaction topic" value={topicId} onChange={(event) => setTopicId(event.target.value)}><option value="">All topics</option>{topicRows.map(({ topic, depth }) => <option key={topic.id} value={topic.id}>{topicLabel(topic.name, depth)}</option>)}</select></label>
        <label><span>From</span><input aria-label="Transaction start date" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label><span>To</span><input aria-label="Transaction end date" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        <div className="filter-actions"><button type="button" onClick={() => void applyFilters()} disabled={loading}>{loading ? <LoaderCircle className="spinner" /> : "Apply filters"}</button>{hasFilters && <button type="button" className="clear-filters" onClick={clearFilters} disabled={loading}>Clear</button>}</div>
      </div>
      {error && <div className="filter-error">{error}</div>}
    </section>
    <section className="panel full-list"><div className="table-title"><div><ReceiptText /><span>{loading ? "Finding transactions…" : `${items.length} ${items.length === 1 ? "transaction" : "transactions"}`}</span></div>{hasFilters && !loading && <span>Filtered results</span>}</div>{!loading && (items.length ? <TransactionRows items={items} showStatus /> : <div className="no-filter-results"><Search /><strong>No matching transactions</strong><span>Try clearing or broadening a filter.</span></div>)}</section>
  </div>;
}

function TransactionRows({ items, showStatus = false }: { items: Transaction[]; showStatus?: boolean }) {
  return <div className="transaction-list">{items.map((item) => <div className="transaction" key={item.id}><div className="merchant-icon">{item.merchant.charAt(0)}</div><div className="transaction-main"><strong>{item.merchant}</strong><span>{new Date(`${item.date}T00:00:00`).toLocaleDateString("en", { day: "numeric", month: "short" })}</span></div><div className="transaction-topics"><span className="category-pill"><i style={{ background: item.category_color }} />{item.category || item.exclusion_reason?.replaceAll("_", " ") || "Pending review"}</span>{item.additional_categories.map((topic) => <span className="context-topic-pill" key={topic.id}>{topic.name}</span>)}</div>{showStatus && <span className={`status ${item.status}`}>{item.status}</span>}<strong className={item.amount >= 0 ? "amount income" : "amount"}>{signedEuro(item.amount)}</strong></div>)}</div>;
}

type ReviewDraft = { description: string; categoryId: number | null; additionalCategoryIds: number[] };
type Approval = { transaction_id: number; description: string; category_id: number; additional_category_ids: number[] };
const blankDraft = (): ReviewDraft => ({ description: "", categoryId: null, additionalCategoryIds: [] });

function ReviewQueue({ items, categories, onApprove, onClassify, onTopicsChanged, busy }: { items: Transaction[]; categories: Category[]; onApprove: (items: Approval[]) => Promise<void>; onClassify: () => Promise<void>; onTopicsChanged: () => Promise<void>; busy: boolean }) {
  const [drafts, setDrafts] = useState<Record<number, ReviewDraft>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState("confidence-asc");
  const [customNames, setCustomNames] = useState<Record<number, string>>({});
  const [customParents, setCustomParents] = useState<Record<number, string>>({});
  const [codexInstructions, setCodexInstructions] = useState<Record<number, string>>({});
  const [proposals, setProposals] = useState<Record<number, TopicProposal>>({});
  const [topicBusy, setTopicBusy] = useState<number | null>(null);
  const [topicErrors, setTopicErrors] = useState<Record<number, string>>({});
  const [reviewError, setReviewError] = useState("");
  const topicRows = useMemo(() => taxonomyRows(categories), [categories]);

  useEffect(() => {
    setDrafts((current) => Object.fromEntries(items.map((item) => {
      const draft = current[item.id];
      return [item.id, {
        description: draft?.description || item.ai_description || "",
        categoryId: draft?.categoryId || item.proposed_category_id,
        additionalCategoryIds: draft?.additionalCategoryIds ?? item.proposed_additional_categories.map((topic) => topic.id),
      }];
    })));
    setSelected((current) => new Set([...current].filter((id) => items.some((item) => item.id === id))));
  }, [items]);

  const sortedItems = useMemo(() => [...items].sort((left, right) => {
    if (sort === "date-desc") return right.date.localeCompare(left.date);
    const leftConfidence = left.confidence ?? -1;
    const rightConfidence = right.confidence ?? -1;
    return sort === "confidence-desc" ? rightConfidence - leftConfidence : leftConfidence - rightConfidence;
  }), [items, sort]);

  const ready = (item: Transaction) => Boolean(drafts[item.id]?.description.trim() && drafts[item.id]?.categoryId);
  const approvalFor = (item: Transaction): Approval | null => {
    const draft = drafts[item.id];
    if (!draft?.description.trim() || !draft.categoryId) return null;
    return { transaction_id: item.id, description: draft.description.trim(), category_id: draft.categoryId, additional_category_ids: draft.additionalCategoryIds };
  };

  const approve = async (candidates: Transaction[]) => {
    const approvals = candidates.map(approvalFor).filter((item): item is Approval => item !== null);
    if (!approvals.length) {
      setReviewError("Add a short description and leaf topic before approving");
      return;
    }
    await onApprove(approvals);
    setSelected(new Set());
  };

  const runCodex = async () => {
    await onClassify();
    setDrafts({});
    setSelected(new Set());
  };

  const createCustom = async (transactionId: number) => {
    const name = customNames[transactionId]?.trim();
    if (!name) return;
    setTopicBusy(transactionId);
    setTopicErrors((current) => ({ ...current, [transactionId]: "" }));
    try {
      const result = await apiRequest<{ topic_id: number }>("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parent_id: customParents[transactionId] ? Number(customParents[transactionId]) : null }),
      });
      setDrafts((current) => ({ ...current, [transactionId]: { ...(current[transactionId] ?? blankDraft()), categoryId: result.topic_id, additionalCategoryIds: (current[transactionId]?.additionalCategoryIds ?? []).filter((id) => id !== result.topic_id) } }));
      await onTopicsChanged();
      setCustomNames((current) => ({ ...current, [transactionId]: "" }));
      setCustomParents((current) => ({ ...current, [transactionId]: "" }));
      setProposals((current) => { const next = { ...current }; delete next[transactionId]; return next; });
    } catch (error) {
      setTopicErrors((current) => ({ ...current, [transactionId]: error instanceof Error ? error.message : "Unable to create topic" }));
    } finally {
      setTopicBusy(null);
    }
  };

  const proposeCustom = async (transactionId: number) => {
    const instructions = codexInstructions[transactionId]?.trim();
    if (!instructions) return;
    setTopicBusy(transactionId);
    setTopicErrors((current) => ({ ...current, [transactionId]: "" }));
    try {
      const proposal = await apiRequest<TopicProposal>("/api/topics/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions }),
      });
      setProposals((current) => ({ ...current, [transactionId]: proposal }));
    } catch (error) {
      setTopicErrors((current) => ({ ...current, [transactionId]: error instanceof Error ? error.message : "Codex could not suggest a topic" }));
    } finally {
      setTopicBusy(null);
    }
  };

  const applyProposal = async (transactionId: number) => {
    const proposal = proposals[transactionId];
    if (!proposal) return;
    setTopicBusy(transactionId);
    try {
      const result = await apiRequest<{ topic_id: number }>(`/api/topics/proposals/${proposal.id}/apply`, { method: "POST" });
      setDrafts((current) => ({ ...current, [transactionId]: { ...(current[transactionId] ?? blankDraft()), categoryId: result.topic_id, additionalCategoryIds: (current[transactionId]?.additionalCategoryIds ?? []).filter((id) => id !== result.topic_id) } }));
      await onTopicsChanged();
      setCustomNames((current) => ({ ...current, [transactionId]: "" }));
      setCustomParents((current) => ({ ...current, [transactionId]: "" }));
      setCodexInstructions((current) => ({ ...current, [transactionId]: "" }));
      setProposals((current) => { const next = { ...current }; delete next[transactionId]; return next; });
    } catch (error) {
      setTopicErrors((current) => ({ ...current, [transactionId]: error instanceof Error ? error.message : "Unable to apply Codex suggestion" }));
    } finally {
      setTopicBusy(null);
    }
  };

  const rejectProposal = async (transactionId: number) => {
    const proposal = proposals[transactionId];
    if (!proposal) return;
    setTopicBusy(transactionId);
    try {
      await apiRequest(`/api/topics/proposals/${proposal.id}/reject`, { method: "POST" });
      setProposals((current) => { const next = { ...current }; delete next[transactionId]; return next; });
    } catch (error) {
      setTopicErrors((current) => ({ ...current, [transactionId]: error instanceof Error ? error.message : "Unable to dismiss suggestion" }));
    } finally {
      setTopicBusy(null);
    }
  };

  const setPrimaryTopic = (transactionId: number, categoryId: number | null) => setDrafts((current) => {
    const draft = current[transactionId] ?? blankDraft();
    return { ...current, [transactionId]: { ...draft, categoryId, additionalCategoryIds: draft.additionalCategoryIds.filter((id) => id !== categoryId) } };
  });

  const toggleAdditionalTopic = (transactionId: number, categoryId: number) => setDrafts((current) => {
    const draft = current[transactionId] ?? blankDraft();
    const selected = draft.additionalCategoryIds.includes(categoryId);
    return { ...current, [transactionId]: { ...draft, additionalCategoryIds: selected ? draft.additionalCategoryIds.filter((id) => id !== categoryId) : [...draft.additionalCategoryIds, categoryId] } };
  });

  if (!items.length) return <div className="review-empty"><div><Check /></div><h2>Review queue cleared</h2><p>New spending will always return here with a Codex proposal before it reaches your categorized dashboards.</p></div>;
  return <div className="review-workspace">
    {reviewError && <div className="topic-error" onClick={() => setReviewError("")}>{reviewError}<span>×</span></div>}
    <div className="review-toolbar">
      <div><strong>{items.length} transactions await approval</strong><span>Review Codex’s description, primary topic, and context topics, then approve.</span></div>
      <div className="review-toolbar-actions">
        <select aria-label="Sort review queue" value={sort} onChange={(event) => setSort(event.target.value)}><option value="confidence-asc">Lowest confidence first</option><option value="confidence-desc">Highest confidence first</option><option value="date-desc">Newest first</option></select>
        <button className="secondary-review-action" onClick={() => void runCodex()} disabled={busy}>{busy ? <LoaderCircle className="spinner" /> : <Sparkles />}Ask Codex</button>
        <button onClick={() => void approve(sortedItems.filter((item) => selected.has(item.id)))} disabled={busy || !selected.size}><Check />Approve selected ({selected.size})</button>
      </div>
    </div>
    <div className="review-batch-bar"><label><input type="checkbox" checked={selected.size === items.length} onChange={(event) => setSelected(event.target.checked ? new Set(items.map((item) => item.id)) : new Set())} />Select all</label><span>{items.filter(ready).length} ready</span><button onClick={() => void approve(items.filter(ready))} disabled={busy || !items.some(ready)}>Approve all ready</button></div>
    <div className="review-table">
      <div className="review-table-head"><span /><span>Transaction</span><span>Codex description</span><span>Primary & context topics</span><span>Confidence</span></div>
      {sortedItems.map((item) => <div className={`review-row ${selected.has(item.id) ? "selected" : ""}`} key={item.id}>
        <input aria-label={`Select ${item.merchant}`} type="checkbox" checked={selected.has(item.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(item.id) : next.delete(item.id); return next; })} />
        <div className="review-transaction"><div><span className="merchant-icon">{item.merchant.charAt(0)}</span><div><strong>{item.merchant}</strong><small className={item.amount >= 0 ? "credit" : ""}>{shortDate(item.date)} · {signedEuro(item.amount)}</small></div></div><p title={item.description}>{item.description}</p></div>
        <textarea aria-label={`Description for ${item.merchant}`} rows={2} maxLength={160} placeholder="Ask Codex or write a short description" value={drafts[item.id]?.description ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...(current[item.id] ?? blankDraft()), description: event.target.value } }))} />
        <div className="review-topic-field"><label className="primary-topic-label">Primary topic<select aria-label={`Primary topic for ${item.merchant}`} value={drafts[item.id]?.categoryId ?? ""} onChange={(event) => setPrimaryTopic(item.id, event.target.value ? Number(event.target.value) : null)}><option value="">Choose a leaf topic</option>{topicRows.map(({ topic, depth }) => <option key={topic.id} value={topic.id} disabled={!topic.is_leaf}>{topicLabel(topic.name, depth)}</option>)}</select></label><details className="additional-topic-picker"><summary>{drafts[item.id]?.additionalCategoryIds.length ? `${drafts[item.id].additionalCategoryIds.length} additional topic${drafts[item.id].additionalCategoryIds.length === 1 ? "" : "s"}` : "Add context topics"}</summary><div>{topicRows.map(({ topic, depth }) => <label className={!topic.is_leaf ? "topic-group-label" : ""} key={topic.id} style={{ paddingLeft: 7 + depth * 14 }}><input type="checkbox" checked={drafts[item.id]?.additionalCategoryIds.includes(topic.id) ?? false} disabled={!topic.is_leaf || drafts[item.id]?.categoryId === topic.id} onChange={() => toggleAdditionalTopic(item.id, topic.id)} />{topic.name}</label>)}</div></details><details><summary>Add a new topic</summary><div className="topic-creation-options"><div className="topic-creation-option"><span>Add directly</span><input aria-label={`New topic name for ${item.merchant}`} placeholder="Specific topic name" value={customNames[item.id] ?? ""} onChange={(event) => setCustomNames({ ...customNames, [item.id]: event.target.value })} /><select aria-label={`Parent for new topic on ${item.merchant}`} value={customParents[item.id] ?? ""} onChange={(event) => setCustomParents({ ...customParents, [item.id]: event.target.value })}><option value="">Root topic</option>{topicRows.map(({ topic, depth }) => <option key={topic.id} value={topic.id}>{topicLabel(topic.name, depth)}</option>)}</select><button disabled={topicBusy !== null || !customNames[item.id]?.trim()} onClick={() => void createCustom(item.id)}><Plus />Add topic</button></div><div className="topic-creation-option codex-topic-option"><span>Plan with Codex</span><textarea aria-label={`Taxonomy request for ${item.merchant}`} maxLength={1000} placeholder="Explain why you need a new topic and how the current topics should be reorganized, if needed." value={codexInstructions[item.id] ?? ""} onChange={(event) => setCodexInstructions({ ...codexInstructions, [item.id]: event.target.value })} /><button disabled={topicBusy !== null || !codexInstructions[item.id]?.trim()} onClick={() => void proposeCustom(item.id)}>{topicBusy === item.id && !proposals[item.id] ? <LoaderCircle className="spinner" /> : <Sparkles />}Make proposal</button>{proposals[item.id] && <InlineTopicProposal proposal={proposals[item.id]} busy={topicBusy === item.id} onApply={() => void applyProposal(item.id)} onReject={() => void rejectProposal(item.id)} />}</div></div>{topicErrors[item.id] && <p className="inline-topic-error">{topicErrors[item.id]}</p>}</details></div>
        <span className={`confidence ${item.confidence === null ? "unknown" : item.confidence < .65 ? "low" : item.confidence < .85 ? "medium" : "high"}`}>{item.confidence === null ? "Not scored" : `${Math.round(item.confidence * 100)}%`}</span>
      </div>)}
    </div>
  </div>;
}

function InlineTopicProposal({ proposal, busy, onApply, onReject }: { proposal: TopicProposal; busy: boolean; onApply: () => void; onReject: () => void }) {
  const title = proposal.action === "merge"
    ? `Use existing topic “${proposal.merge_target_name}”`
    : proposal.action === "restructure"
      ? `Restructure and add “${proposal.new_name}”`
      : `Add “${proposal.new_name}”${proposal.parent_name ? ` under “${proposal.parent_name}”` : " as a root topic"}`;
  return <div className="inline-topic-proposal"><div><span>Codex suggestion</span><strong>{title}</strong><p>{proposal.reason}</p>{proposal.moves.length > 0 && <ul>{proposal.moves.map((move) => <li key={move.topic_id}>Move {move.topic_name} {move.new_parent_name ? `under ${move.new_parent_name}` : "to the root"}</li>)}</ul>}</div><div><button onClick={onReject} disabled={busy}>Dismiss</button><button onClick={onApply} disabled={busy}>{busy ? <LoaderCircle className="spinner" /> : <Check />}Use suggestion</button></div></div>;
}

function EmptyState({ loading = false }: { loading?: boolean }) {
  return <div className="empty-state">{loading ? <LoaderCircle className="spinner" /> : <Upload />}<h2>{loading ? "Preparing your dashboard" : "Import your first statement"}</h2><p>{loading ? "Just a moment…" : "Upload the .xls or .xlsx file downloaded from your bank to see where your money goes."}</p></div>;
}
