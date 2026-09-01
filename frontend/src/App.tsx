import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  BellRing,
  CalendarRange,
  ChartNoAxesCombined,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FileSpreadsheet,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  Plus,
  ReceiptText,
  RotateCcw,
  Search,
  Sparkles,
  Tags,
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
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiRequest, uploadRequest } from "./api";
import { taxonomyRows, topicLabel } from "./topicTaxonomy";
import TopicsPage from "./Topics";
import NotificationsPage from "./Notifications";
import type { Category, CoverageData, DashboardData, TopicProposal, Transaction } from "./types";

type View = "dashboard" | "transactions" | "review" | "topics" | "notifications";
type CodexProgress = { completed: number; total: number; remainingSeconds: number | null; updatedAt: number };
type ImportProgress = {
  filename: string;
  phase: "uploading" | "reading" | "reviewing" | "complete";
  uploadPercentage: number;
  imported?: number;
  duplicates?: number;
};
type MonthlyChartRow = Record<string, string | number> & { month: string; netTotal: number };
type SwipeOrigin = { x: number; y: number; lastX: number; startedAt: number; axis: "x" | "y" | null };
const appBase = import.meta.env.BASE_URL.replace(/\/$/, "");
const viewOrder: View[] = ["dashboard", "transactions", "topics", "review", "notifications"];
const viewPaths: Record<View, string> = {
  dashboard: `${appBase}/overview`,
  transactions: `${appBase}/transactions`,
  topics: `${appBase}/topics`,
  review: `${appBase}/review`,
  notifications: `${appBase}/notifications`,
};
const codexBatchSize = 20;
const viewFromPath = (path: string): View => (Object.entries(viewPaths).find(([, value]) => value === path)?.[0] as View | undefined) ?? "dashboard";
const euro = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const compactEuro = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", notation: "compact" });
const monthLabel = (value: string) => new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(`${value}-01T00:00:00`));
const shortMonth = (value: string) => new Intl.DateTimeFormat("en", { month: "short" }).format(new Date(`${value}-01T00:00:00`));
const shortDate = (value: string) => new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
const rangeLabel = (start: string, end: string) => start === end ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`;
const signedEuro = (amount: number) => `${amount >= 0 ? "+" : "−"}${euro.format(Math.abs(amount))}`;
const dayMilliseconds = 86_400_000;
const dateValue = (value: string) => Date.parse(`${value}T00:00:00Z`);
const addDays = (value: string, days: number) => new Date(dateValue(value) + days * dayMilliseconds).toISOString().slice(0, 10);
const inclusiveDays = (start: string, end: string) => Math.round((dateValue(end) - dateValue(start)) / dayMilliseconds) + 1;
const today = () => {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
};

export default function App() {
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname));
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
  const [codexProgress, setCodexProgress] = useState<CodexProgress | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [draggedFilename, setDraggedFilename] = useState("");
  const [isDraggingStatement, setIsDraggingStatement] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swipeAnimating, setSwipeAnimating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const swipeOrigin = useRef<SwipeOrigin | null>(null);
  const swipeTimer = useRef<number | null>(null);
  const importTimer = useRef<number | null>(null);
  const dragDepth = useRef(0);
  const importStatementRef = useRef<(file: File) => Promise<void>>(async () => {});

  const navigate = (nextView: View) => {
    if (window.location.pathname !== viewPaths[nextView]) window.history.pushState({}, "", viewPaths[nextView]);
    setView(nextView);
  };

  useEffect(() => {
    const initialView = viewFromPath(window.location.pathname);
    if (window.location.pathname !== viewPaths[initialView]) window.history.replaceState({}, "", viewPaths[initialView]);
    const syncView = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);

  useEffect(() => () => {
    if (swipeTimer.current !== null) window.clearTimeout(swipeTimer.current);
    if (importTimer.current !== null) window.clearTimeout(importTimer.current);
  }, []);

  const settleSwipe = () => {
    setSwipeAnimating(true);
    setSwipeOffset(0);
    swipeTimer.current = window.setTimeout(() => setSwipeAnimating(false), 220);
  };

  const completeSwipe = (nextView: View, direction: -1 | 1) => {
    setSwipeAnimating(true);
    setSwipeOffset(-direction * window.innerWidth);
    swipeTimer.current = window.setTimeout(() => {
      navigate(nextView);
      setSwipeAnimating(false);
      setSwipeOffset(direction * window.innerWidth * 0.22);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        setSwipeAnimating(true);
        setSwipeOffset(0);
        swipeTimer.current = window.setTimeout(() => setSwipeAnimating(false), 240);
      }));
    }, 180);
  };

  const startSwipe = (event: React.TouchEvent<HTMLElement>) => {
    if (swipeAnimating || event.touches.length !== 1 || !window.matchMedia("(max-width: 760px)").matches) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, select, textarea, a, details, [contenteditable], [data-swipe-ignore], .recharts-wrapper, .review-table")) return;
    const touch = event.touches[0];
    swipeOrigin.current = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, startedAt: performance.now(), axis: null };
  };

  const moveSwipe = (event: React.TouchEvent<HTMLElement>) => {
    const origin = swipeOrigin.current;
    if (!origin || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - origin.x;
    const deltaY = touch.clientY - origin.y;
    origin.lastX = touch.clientX;
    if (!origin.axis && Math.hypot(deltaX, deltaY) > 8) origin.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
    if (origin.axis !== "x") return;
    const index = viewOrder.indexOf(view);
    const atEdge = (index === 0 && deltaX > 0) || (index === viewOrder.length - 1 && deltaX < 0);
    setSwipeOffset(atEdge ? deltaX * 0.22 : deltaX);
  };

  const endSwipe = () => {
    const origin = swipeOrigin.current;
    swipeOrigin.current = null;
    if (!origin || origin.axis !== "x") return;
    const deltaX = origin.lastX - origin.x;
    const direction = deltaX < 0 ? 1 : -1;
    const nextIndex = viewOrder.indexOf(view) + direction;
    const elapsed = Math.max(performance.now() - origin.startedAt, 1);
    const committed = Math.abs(deltaX) > Math.min(window.innerWidth * 0.22, 84)
      || (Math.abs(deltaX) > 30 && Math.abs(deltaX) / elapsed > 0.45);
    if (!committed || nextIndex < 0 || nextIndex >= viewOrder.length) {
      settleSwipe();
      return;
    }
    completeSwipe(viewOrder[nextIndex], direction);
  };

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
      setMonthDetail(null);
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

  const importStatement = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    setBusy(true);
    setNotice("");
    setImportProgress({ filename: file.name, phase: "uploading", uploadPercentage: 0 });
    try {
      const result = await uploadRequest<{ imported: number; duplicates: number; pending_review: number }>("/api/imports", form, (uploadPercentage) => {
        setImportProgress((current) => current ? { ...current, uploadPercentage, phase: current.phase === "uploading" && uploadPercentage === 100 ? "reading" : current.phase } : current);
        if (uploadPercentage === 100 && importTimer.current === null) {
          importTimer.current = window.setTimeout(() => {
            setImportProgress((current) => current && current.phase === "reading" ? { ...current, phase: "reviewing" } : current);
            importTimer.current = null;
          }, 700);
        }
      });
      if (importTimer.current !== null) window.clearTimeout(importTimer.current);
      importTimer.current = null;
      setImportProgress((current) => current ? { ...current, phase: "complete", uploadPercentage: 100, imported: result.imported, duplicates: result.duplicates } : current);
      setNotice(`${result.imported} transactions imported · ${result.duplicates} duplicates skipped · ${result.pending_review} need review`);
      const reviewItems = apiRequest<Transaction[]>("/api/review");
      await load("");
      setReview(await reviewItems);
      navigate("review");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import failed");
    } finally {
      if (importTimer.current !== null) window.clearTimeout(importTimer.current);
      importTimer.current = null;
      setImportProgress(null);
      setBusy(false);
    }
  };

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void importStatement(file);
  };

  const canDropStatement = view === "dashboard" && !busy;
  importStatementRef.current = importStatement;
  useEffect(() => {
    if (!canDropStatement) return;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const clearDrag = () => {
      dragDepth.current = 0;
      setDraggedFilename("");
      setIsDraggingStatement(false);
    };
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      const file = event.dataTransfer?.files[0] ?? Array.from(event.dataTransfer?.items ?? []).find((item) => item.kind === "file")?.getAsFile();
      setDraggedFilename(file?.name ?? "");
      setIsDraggingStatement(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) clearDrag();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      clearDrag();
      if (files.length !== 1 || !/\.xlsx?$/i.test(files[0].name)) {
        setNotice("Drop one .xls or .xlsx bank statement to import it");
        return;
      }
      void importStatementRef.current(files[0]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      clearDrag();
    };
  }, [canDropStatement]);

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
    const transactionIds = review.map((item) => item.id);
    if (!transactionIds.length) return;
    setBusy(true);
    setNotice("");
    setCodexProgress({ completed: 0, total: transactionIds.length, remainingSeconds: null, updatedAt: Date.now() });
    const startedAt = performance.now();
    let completed = 0;
    let updated = 0;
    try {
      for (let index = 0; index < transactionIds.length; index += codexBatchSize) {
        const batch = transactionIds.slice(index, index + codexBatchSize);
        const result = await apiRequest<{ updated: number; processed: number }>("/api/review/classify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transaction_ids: batch }),
        });
        completed += batch.length;
        updated += result.updated;
        const elapsedSeconds = (performance.now() - startedAt) / 1000;
        setCodexProgress({
          completed,
          total: transactionIds.length,
          remainingSeconds: elapsedSeconds / completed * (transactionIds.length - completed),
          updatedAt: Date.now(),
        });
        setReview(await apiRequest<Transaction[]>("/api/review"));
      }
      setNotice(`Codex prepared ${updated} proposals · ${transactionIds.length} await your approval`);
      await load(period);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex classification failed";
      setNotice(`${message} · ${completed} of ${transactionIds.length} completed`);
    } finally {
      setCodexProgress(null);
      setBusy(false);
    }
  };

  const excludeReviewTransaction = async (item: Transaction) => {
    await apiRequest<Transaction>(`/api/transactions/${item.id}/exclusion`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded: true }),
    });
    setReview((current) => current.filter((candidate) => candidate.id !== item.id));
    setDashboard((current) => current ? { ...current, pending: Math.max(0, current.pending - 1), pending_total: Math.max(0, current.pending_total - 1) } : current);
    setNotice(`${item.merchant} excluded from spending analytics`);
  };

  const applyRange = () => {
    if (!rangeStart || !rangeEnd) {
      setNotice("Choose both a start and an end date");
      return;
    }
    if (rangeStart > rangeEnd) {
      setNotice("The start date must be before the end date");
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
      const params = new URLSearchParams({ year: month.slice(0, 4), month: String(Number(month.slice(5))) });
      if (dashboard?.is_custom) {
        const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
        params.set("start_date", dashboard.range_start > `${month}-01` ? dashboard.range_start : `${month}-01`);
        params.set("end_date", dashboard.range_end < monthEnd ? dashboard.range_end : monthEnd);
      }
      setMonthDetail(await apiRequest<DashboardData>(`/api/dashboard?${params}`));
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
          <NavItem active={view === "dashboard"} icon={<LayoutDashboard />} label="Overview" onClick={() => navigate("dashboard")} />
          <NavItem active={view === "transactions"} icon={<ReceiptText />} label="Transactions" onClick={() => navigate("transactions")} />
          <NavItem active={view === "topics"} icon={<Tags />} label="Topics" onClick={() => navigate("topics")} />
          <NavItem active={view === "review"} icon={<CircleHelp />} label="Review" badge={dashboard?.pending_total} onClick={() => navigate("review")} />
          <NavItem active={view === "notifications"} icon={<BellRing />} label="Notifications" onClick={() => navigate("notifications")} />
        </nav>
        <div className="privacy-note"><WalletCards /><div><strong>Local by design</strong><span>Your financial data stays on this computer.</span></div></div>
      </aside>

      <main onTouchStart={startSwipe} onTouchMove={moveSwipe} onTouchEnd={endSwipe} onTouchCancel={endSwipe}>
        <div className={swipeAnimating ? "swipe-content animating" : "swipe-content"} style={{ transform: `translate3d(${swipeOffset}px, 0, 0)` }}>
        <header>
          <div><p className="eyebrow">PERSONAL SPENDING</p><h1>{view === "dashboard" ? "Overview" : view === "transactions" ? "Transactions" : view === "topics" ? "Topics" : view === "notifications" ? "Notifications" : "Review classifications"}</h1></div>
          <div className="header-actions">
            <button className="import-button" onClick={() => fileInput.current?.click()} disabled={busy}><Upload />Import statement</button>
            <input ref={fileInput} type="file" accept=".xls,.xlsx" hidden onChange={importFile} />
          </div>
        </header>

        {notice && <div className="notice" onClick={() => setNotice("")}>{notice}<span>×</span></div>}
        {view === "review" && codexProgress && <CodexProgressBanner progress={codexProgress} />}
        {view === "dashboard" && dashboard?.available_periods.length ? <div className="range-bar"><div><CalendarRange /><strong>Custom spending range</strong></div><DateRangePicker start={rangeStart} end={rangeEnd} initialMonth={dashboard.period} busy={busy} onChange={(start, end) => { setRangeStart(start); setRangeEnd(end); }} onApply={applyRange} />{dashboard.is_custom && <button className="clear-range" onClick={clearRange}>Clear</button>}</div> : null}
        {view === "notifications" ? <NotificationsPage /> : busy && !dashboard ? <EmptyState loading /> : view === "dashboard" ? <Dashboard data={dashboard} topics={categories} coverage={coverage} monthDetail={monthDetail} monthBusy={monthBusy} onMonthSelect={loadMonthDetail} onCloseMonth={() => setMonthDetail(null)} /> : view === "transactions" ? <TransactionList initialItems={transactions} categories={categories} /> : view === "topics" ? <TopicsPage /> : <ReviewQueue items={review} categories={categories} onApprove={approveTransactions} onExclude={excludeReviewTransaction} onClassify={classifyPending} onTopicsChanged={async () => setCategories(await apiRequest<Category[]>("/api/categories"))} busy={busy} />}
        </div>
      </main>
      {isDraggingStatement && <OverviewDropOverlay filename={draggedFilename} />}
      {importProgress && <ImportProgressDialog progress={importProgress} />}
    </div>
  );
}

function OverviewDropOverlay({ filename }: { filename: string }) {
  return <div className="overview-drop-backdrop" role="status" aria-live="polite"><div className="overview-drop-area"><div className="overview-drop-content"><div className="overview-drop-icon"><FileSpreadsheet />{filename && <span>{filename}</span>}</div><h2>Drop your bank statement</h2><p>Release it anywhere to start the import.</p><small>Supports .xls and .xlsx</small></div></div></div>;
}

function ImportProgressDialog({ progress }: { progress: ImportProgress }) {
  const uploaded = progress.phase !== "uploading";
  const reviewed = progress.phase === "complete";
  const reviewing = progress.phase === "reviewing";
  const progressWidth = progress.phase === "uploading" ? `${progress.uploadPercentage}%` : undefined;
  return (
    <div className="import-progress-backdrop" role="presentation">
      <section className="import-progress-dialog" role="dialog" aria-modal="true" aria-labelledby="import-progress-title" aria-describedby="import-progress-note">
        <div className="import-progress-heading">
          <div className="import-file-icon"><FileSpreadsheet /></div>
          <div><h2 id="import-progress-title">{reviewed ? "Review ready" : "Preparing your review"}</h2><p>{progress.filename}</p></div>
        </div>
        <div className={`import-progress-track ${uploaded && !reviewed ? "indeterminate" : ""}`} role="progressbar" aria-label="Statement import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={reviewed ? 100 : progress.phase === "uploading" ? progress.uploadPercentage : undefined}>
          <i style={progressWidth ? { width: progressWidth } : undefined} />
        </div>
        <div className="import-progress-stages">
          <ImportStage state={uploaded ? "done" : "active"} label="Statement uploaded" detail={uploaded ? "Complete" : `${progress.uploadPercentage}%`} />
          <ImportStage state={reviewed || reviewing ? "done" : uploaded ? "active" : "pending"} label="Transactions found" detail={reviewed ? `${progress.imported} new` : undefined} />
          <ImportStage state={reviewed ? "done" : reviewing ? "active" : "pending"} label="Codex is preparing suggestions" detail={reviewed ? "Complete" : reviewing ? "Usually under a minute" : undefined} sparkle />
        </div>
        <p className="import-progress-note" id="import-progress-note">{reviewed ? `${progress.imported} transactions imported · ${progress.duplicates} duplicates skipped` : "Keep this page open. Your review queue will appear automatically."}</p>
      </section>
    </div>
  );
}

function ImportStage({ state, label, detail, sparkle = false }: { state: "done" | "active" | "pending"; label: string; detail?: string; sparkle?: boolean }) {
  return <div className={`import-progress-stage ${state}`}><span>{state === "done" ? <Check /> : sparkle ? <Sparkles /> : <LoaderCircle />}</span><strong>{label}</strong><small>{detail}</small></div>;
}

function CodexProgressBanner({ progress }: { progress: CodexProgress }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const percentage = Math.round(progress.completed / progress.total * 100);
  const remaining = progress.remainingSeconds === null
    ? null
    : Math.max(0, progress.remainingSeconds - (now - progress.updatedAt) / 1000);
  const eta = remaining === null
    ? "Estimating time remaining…"
    : remaining < 60 ? "Less than a minute left" : `About ${Math.ceil(remaining / 60)} min left`;
  return (
    <section className="codex-progress" aria-live="polite">
      <div><span><Sparkles />Codex is reviewing transactions</span><strong>{progress.completed} of {progress.total} · {eta}</strong></div>
      <div className="codex-progress-track" role="progressbar" aria-label="Codex classification progress" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed}>
        <i style={{ width: `${percentage}%` }} />
      </div>
    </section>
  );
}

function NavItem({ active, icon, label, badge, onClick }: { active: boolean; icon: React.ReactNode; label: string; badge?: number; onClick: () => void }) {
  return <button className={active ? "nav-item active" : "nav-item"} aria-current={active ? "page" : undefined} aria-label={label} title={label} onClick={onClick}>{icon}<span>{label}</span>{badge ? <em>{badge}</em> : null}</button>;
}

const shiftMonth = (month: string, amount: number) => {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + amount, 1)).toISOString().slice(0, 7);
};

const calendarDates = (month: string) => {
  const first = `${month}-01`;
  const weekday = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(first, -weekday);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
};

function DateRangePicker({ start, end, initialMonth, busy, onChange, onApply }: { start: string; end: string; initialMonth: string; busy: boolean; onChange: (start: string, end: string) => void; onApply: () => void }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(start.slice(0, 7) || initialMonth);
  const picker = useRef<HTMLDivElement>(null);
  const dates = calendarDates(month);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!picker.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeWithKeyboard);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeWithKeyboard);
    };
  }, [open]);

  const selectDate = (date: string) => {
    if (!start || end) {
      onChange(date, "");
      return;
    }
    if (date < start) onChange(date, start);
    else onChange(start, date);
  };

  const apply = () => {
    onApply();
    setOpen(false);
  };

  return <div className="date-range-picker" ref={picker}>
    <button className="date-range-trigger" aria-expanded={open} onClick={() => { setMonth(start.slice(0, 7) || initialMonth); setOpen((current) => !current); }}><CalendarRange /><span>{start && end ? rangeLabel(start, end) : start ? `${shortDate(start)} – Choose end` : "Choose date range"}</span></button>
    {open && <div className="range-calendar">
      <div className="range-calendar-selection"><div><span>Start date</span><strong>{start ? shortDate(start) : "Select a date"}</strong></div><div><span>End date</span><strong>{end ? shortDate(end) : "Select a date"}</strong></div></div>
      <div className="range-calendar-heading"><button aria-label="Previous month" onClick={() => setMonth((current) => shiftMonth(current, -1))}><ChevronLeft /></button><strong>{monthLabel(month)}</strong><button aria-label="Next month" onClick={() => setMonth((current) => shiftMonth(current, 1))}><ChevronRight /></button></div>
      <div className="range-calendar-weekdays">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="range-calendar-days">{dates.map((date, index) => {
        const selected = date === start || date === end;
        const inRange = Boolean(start && end && date >= start && date <= end);
        const className = [date.slice(0, 7) !== month ? "outside" : "", inRange ? "in-range" : "", inRange && index % 7 === 0 ? "week-start" : "", inRange && index % 7 === 6 ? "week-end" : "", date === start ? "range-start" : "", date === end ? "range-end" : ""].filter(Boolean).join(" ");
        return <button key={date} className={className} aria-label={shortDate(date)} aria-pressed={selected} onClick={() => selectDate(date)}>{Number(date.slice(8))}</button>;
      })}</div>
      <div className="range-calendar-actions"><span>{start && !end ? "Now choose an end date" : start && end ? `${inclusiveDays(start, end)} days selected` : "Choose the first day"}</span><button disabled={busy || !start || !end} onClick={apply}>Apply range</button></div>
    </div>}
  </div>;
}

function Dashboard({ data, topics, coverage, monthDetail, monthBusy, onMonthSelect, onCloseMonth }: { data: DashboardData | null; topics: Category[]; coverage: CoverageData | null; monthDetail: DashboardData | null; monthBusy: boolean; onMonthSelect: (month: string) => Promise<void>; onCloseMonth: () => void }) {
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [pieTooltipOpen, setPieTooltipOpen] = useState(false);
  const categoryNames = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of data?.monthly ?? []) {
      for (const [name, value] of Object.entries(row)) {
        if (name !== "month") totals.set(name, (totals.get(name) ?? 0) + Number(value));
      }
    }
    return [...totals].sort((left, right) => right[1] - left[1]).map(([name]) => name);
  }, [data]);
  const monthlyData = useMemo<MonthlyChartRow[]>(() => (data?.monthly ?? []).map((row) => ({
    ...row,
    month: String(row.month),
    netTotal: Number(Object.entries(row).reduce(
      (total, [name, value]) => name === "month" ? total : total + Number(value),
      0,
    ).toFixed(2)),
  })), [data]);
  const colors = Object.fromEntries((data?.categories ?? []).map((item) => [item.name, item.color]));
  const topicsById = new Map(topics.map((topic) => [topic.id, topic]));
  const selectedTotal = (data?.categories ?? []).reduce((total, item) => selectedCategories.has(item.name) ? total + item.value : total, 0);
  const recentTransactions = (data?.transactions ?? []).filter((item) => {
    if (!selectedCategories.size) return true;
    if (!item.category_id) return selectedCategories.has("Pending review");
    let topic = topicsById.get(item.category_id);
    while (topic?.parent_id) topic = topicsById.get(topic.parent_id);
    return Boolean(topic && selectedCategories.has(topic.name));
  });
  const toggleCategory = (name: string) => setSelectedCategories((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });
  const clearCategorySelection = useCallback(() => {
    setSelectedCategories(new Set());
    setPieTooltipOpen(false);
  }, []);
  useEffect(clearCategorySelection, [data?.range_start, data?.range_end, clearCategorySelection]);
  useEffect(() => {
    const clearSelection = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearCategorySelection();
    };
    const clearOutsideSelection = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".category-list button, .donut .recharts-sector")) clearCategorySelection();
    };
    window.addEventListener("keydown", clearSelection);
    window.addEventListener("mousedown", clearOutsideSelection);
    return () => {
      window.removeEventListener("keydown", clearSelection);
      window.removeEventListener("mousedown", clearOutsideSelection);
    };
  }, [clearCategorySelection]);
  if (!data || !data.available_periods.length) return <EmptyState />;
  const positiveCategories = data.categories.filter((item) => item.value > 0);
  const activeRange = rangeLabel(data.range_start, data.range_end);
  return (
    <div className="dashboard">
      <section className="kpi-grid">
        <Kpi label={data.is_custom ? "Net spent in range" : "Net spent this month"} value={euro.format(data.total)} detail={`${data.expense_count} expenses · ${data.credit_count} credits`} icon={<WalletCards />} />
        <Kpi label={data.is_custom ? "Previous equal period" : "Month over month"} value={data.change === null ? "—" : `${Math.abs(data.change).toFixed(1)}%`} detail={data.change === null ? "No preceding data" : data.change > 0 ? "More than before" : "Less than before"} icon={data.change !== null && data.change > 0 ? <ArrowUpRight /> : <ArrowDownRight />} tone={data.change !== null && data.change > 0 ? "warning" : "good"} />
        <Kpi label="Average net transaction" value={euro.format(data.average)} detail={data.is_custom ? `${shortDate(data.range_start)} – ${shortDate(data.range_end)}` : monthLabel(data.period)} icon={<ChartNoAxesCombined />} />
        <Kpi label="Needs review" value={String(data.pending)} detail={data.pending ? "Help improve future imports" : "Everything is categorized"} icon={data.pending ? <CircleHelp /> : <Check />} tone={data.pending ? "warning" : "good"} />
      </section>

      <section className="panel chart-panel">
        <div className="panel-heading"><div><p className="eyebrow">SPENDING HISTORY</p><PanelTitle title="Net monthly spend by category" range={activeRange} /></div><span>{monthBusy ? "Loading month…" : "Click a month for details"}</span></div>
        <div className="bar-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlyData} margin={{ top: 20, right: 8, left: -12, bottom: 0 }} stackOffset="sign" barGap={-22} onClick={(event) => { if (event?.activeLabel) void onMonthSelect(String(event.activeLabel)); }}>
              <CartesianGrid vertical={false} stroke="#e8e7e3" />
              <XAxis dataKey="month" tickFormatter={shortMonth} axisLine={false} tickLine={false} tick={{ fill: "#8b8f99", fontSize: 12 }} />
              <YAxis tickFormatter={(value) => compactEuro.format(value)} axisLine={false} tickLine={false} tick={{ fill: "#8b8f99", fontSize: 12 }} />
              <ReferenceLine y={0} stroke="#a5a7aa" strokeWidth={1.2} />
              <Tooltip
                cursor={{ fill: "#f6f5f2" }}
                content={({ active, label }) => {
                  const month = monthlyData.find((row) => row.month === label);
                  if (!active || !month) return null;
                  return <div className="monthly-tooltip"><strong>{monthLabel(String(label))}</strong><ul>{categoryNames.filter((name) => name in month).map((name) => <li key={name}><span><i style={{ background: colors[name] || "#B2B8C5" }} />{name}</span><b>{euro.format(Number(month[name]))}</b></li>)}</ul><footer><span>Net total</span><b>{euro.format(month.netTotal)}</b></footer></div>;
                }}
              />
              {categoryNames.map((name) => <Bar key={name} dataKey={name} stackId="topics" barSize={34} fill={colors[name] || "#B2B8C5"} fillOpacity={0.52} />)}
              <Bar dataKey="netTotal" barSize={10} radius={[3, 3, 3, 3]}>
                {monthlyData.map((row) => <Cell key={String(row.month)} fill={row.netTotal < 0 ? "#9E395F" : "#29243A"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="legend">{categoryNames.map((name) => <span key={name}><i style={{ background: colors[name] || "#B2B8C5" }} />{name}</span>)}<span className="net-total-legend"><i />Net total</span></div>
        <div className="chart-note">Wide stacks show topic totals · Narrow dark columns show net monthly spend</div>
      </section>

      {monthDetail && <MonthDetail data={monthDetail} onClose={onCloseMonth} />}

      <div className="lower-grid">
        <section className="panel category-panel">
          <div className="panel-heading"><div><p className="eyebrow">BREAKDOWN</p><PanelTitle title="Net by category" range={activeRange} /></div></div>
          <div className="category-content">
            <div className="donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={positiveCategories} dataKey="value" innerRadius={60} outerRadius={82} paddingAngle={2}>{positiveCategories.map((item) => <Cell key={item.name} fill={item.color} opacity={!selectedCategories.size || selectedCategories.has(item.name) ? 1 : 0.35} stroke={selectedCategories.has(item.name) ? "#202329" : "#fff"} strokeWidth={selectedCategories.has(item.name) ? 2 : 1} style={{ cursor: "pointer" }} onMouseEnter={() => setPieTooltipOpen(true)} onMouseLeave={() => setPieTooltipOpen(false)} onClick={() => {
              const wasSelected = selectedCategories.has(item.name);
              toggleCategory(item.name);
              setPieTooltipOpen(!wasSelected);
            }} />)}</Pie><Tooltip active={pieTooltipOpen ? undefined : false} wrapperStyle={{ zIndex: 1 }} content={({ active, payload }) => {
              const item = payload?.[0]?.payload as DashboardData["categories"][number] | undefined;
              return active && item ? <div className="category-tooltip"><span><i style={{ background: item.color }} />{item.name}</span><strong>{euro.format(item.value)}</strong></div> : null;
            }} /></PieChart></ResponsiveContainer><div aria-live="polite"><strong>{euro.format(selectedCategories.size ? selectedTotal : data.total)}</strong><span>{selectedCategories.size ? "Selected total" : "Net total"}</span></div></div>
            <div className="category-list">{data.categories.map((item) => <button className={selectedCategories.has(item.name) ? "selected" : ""} key={item.name} aria-pressed={selectedCategories.has(item.name)} onClick={() => {
              setPieTooltipOpen(false);
              toggleCategory(item.name);
            }}><span><i style={{ background: item.color }} />{item.name}</span><strong className={item.value < 0 ? "net-credit" : ""}>{euro.format(item.value)}</strong></button>)}</div>
          </div>
        </section>
        <section className="panel recent-panel"><div className="panel-heading"><div><p className="eyebrow">ACTIVITY</p><PanelTitle title="Recent transactions" range={activeRange} /></div>{selectedCategories.size > 0 && <button className="clear-category-filter" onClick={clearCategorySelection}>Clear filter</button>}</div>{recentTransactions.length ? <TransactionRows items={recentTransactions} /> : <div className="no-recent-transactions"><Search /><strong>No recent transactions</strong><span>{selectedCategories.size ? "Try selecting another category." : "There are no transactions in this period."}</span></div>}</section>
      </div>

      <CoverageTimeline coverage={coverage} rangeStart={data.is_custom ? data.range_start : undefined} rangeEnd={data.is_custom ? data.range_end : undefined} />
    </div>
  );
}

type CoverageSegment = { start: string; end: string; imported: boolean; days: number };

function coverageSegments(coverage: CoverageData, timelineStart: string, timelineEnd: string): CoverageSegment[] {
  if (!coverage.start || !coverage.end || timelineStart > timelineEnd) return [];
  const importedRanges: { start: string; end: string }[] = [];
  let importedStart = coverage.start;
  for (const gap of coverage.gaps) {
    importedRanges.push({ start: importedStart, end: addDays(gap.start, -1) });
    importedStart = addDays(gap.end, 1);
  }
  importedRanges.push({ start: importedStart, end: coverage.end });
  const segments: CoverageSegment[] = [];
  let cursor = timelineStart;
  for (const range of importedRanges) {
    const start = range.start < timelineStart ? timelineStart : range.start;
    const end = range.end > timelineEnd ? timelineEnd : range.end;
    if (start > end) continue;
    if (cursor < start) {
      const gapEnd = addDays(start, -1);
      segments.push({ start: cursor, end: gapEnd, imported: false, days: inclusiveDays(cursor, gapEnd) });
    }
    segments.push({ start, end, imported: true, days: inclusiveDays(start, end) });
    cursor = addDays(end, 1);
  }
  if (cursor <= timelineEnd) segments.push({ start: cursor, end: timelineEnd, imported: false, days: inclusiveDays(cursor, timelineEnd) });
  return segments;
}

function CoverageTimeline({ coverage, rangeStart, rangeEnd }: { coverage: CoverageData | null; rangeStart?: string; rangeEnd?: string }) {
  const timelineStart = rangeStart ?? coverage?.start;
  const timelineEnd = rangeEnd ?? today();
  if (!coverage?.start) return null;
  if (!timelineStart) return null;
  const segments = coverageSegments(coverage, timelineStart, timelineEnd);
  if (!segments.length) return null;
  const importedSegments = segments.filter((segment) => segment.imported);
  const gapCount = segments.filter((segment) => !segment.imported).length;
  const description = segments.map((segment) => `${segment.imported ? "Imported" : "Not imported"} ${shortDate(segment.start)} to ${shortDate(segment.end)}`).join("; ");

  return <section className="panel coverage-timeline">
    <div className="panel-heading">
      <div><p className="eyebrow">STATEMENT HISTORY</p><PanelTitle title="Imported transaction coverage" range={rangeLabel(timelineStart, timelineEnd)} /></div>
      <span>{gapCount ? `${gapCount} ${gapCount === 1 ? "gap" : "gaps"}` : "Complete coverage"}</span>
    </div>
    <p className="coverage-subtitle">{rangeStart ? "Coverage within the selected spending range" : "From the earliest imported statement through today"}</p>
    <div className="coverage-track" role="img" aria-label={description}>
      {segments.map((segment) => <span
        key={`${segment.start}-${segment.imported}`}
        className={segment.imported ? "coverage-segment imported" : "coverage-segment gap"}
        style={{ flexGrow: segment.days }}
        title={`${segment.imported ? "Imported" : "Not imported"} · ${shortDate(segment.start)} – ${shortDate(segment.end)}`}
      />)}
    </div>
    <div className="coverage-axis"><span>{shortDate(timelineStart)}</span><span>{rangeEnd ? shortDate(timelineEnd) : `Today · ${shortDate(timelineEnd)}`}</span></div>
    <div className="coverage-legend"><span><i className="imported" />Imported</span><span><i className="gap" />Not imported</span></div>
    <div className="coverage-ranges"><strong>Imported regions</strong><div>{importedSegments.map((segment) => <span key={`${segment.start}-${segment.end}`}><i />{rangeLabel(segment.start, segment.end)}</span>)}</div></div>
  </section>;
}

function PanelTitle({ title, range }: { title: string; range: string }) {
  return <h2>{title}<small>{range}</small></h2>;
}

function MonthDetail({ data, onClose }: { data: DashboardData; onClose: () => void }) {
  const categoryScale = Math.max(1, ...data.categories.map((category) => Math.abs(category.value)));
  return <section className="panel month-detail">
    <div className="month-detail-heading"><div><p className="eyebrow">MONTH DETAIL</p><h2>{data.is_custom ? rangeLabel(data.range_start, data.range_end) : monthLabel(data.period)}</h2></div><button aria-label="Close month details" onClick={onClose}>×</button></div>
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
  const [filtersApplied, setFiltersApplied] = useState(false);
  const [topicEdit, setTopicEdit] = useState<{ transactionId: number; description: string; categoryId: number | null; additionalCategoryIds: number[] } | null>(null);
  const [topicSaving, setTopicSaving] = useState(false);
  const [exclusionBusy, setExclusionBusy] = useState<number | null>(null);
  const [excludeCandidate, setExcludeCandidate] = useState<Transaction | null>(null);
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
      setFiltersApplied(Boolean(params.size));
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
      .then((nextItems) => {
        setItems(nextItems);
        setFiltersApplied(false);
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to load transactions"))
      .finally(() => setLoading(false));
  };

  const editTopics = (item: Transaction) => setTopicEdit({
    transactionId: item.id,
    description: item.ai_description ?? "",
    categoryId: item.category_id ?? item.proposed_category_id,
    additionalCategoryIds: (item.additional_categories.length ? item.additional_categories : item.proposed_additional_categories).map((topic) => topic.id),
  });

  const toggleEditTopic = (categoryId: number) => setTopicEdit((current) => {
    if (!current) return current;
    const selected = current.additionalCategoryIds.includes(categoryId);
    return { ...current, additionalCategoryIds: selected ? current.additionalCategoryIds.filter((id) => id !== categoryId) : [...current.additionalCategoryIds, categoryId] };
  });

  const saveTopics = async () => {
    if (!topicEdit?.categoryId || !topicEdit.description.trim()) return;
    setTopicSaving(true);
    setError("");
    try {
      const updated = await apiRequest<Transaction>(`/api/transactions/${topicEdit.transactionId}/topics`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: topicEdit.description.trim(), category_id: topicEdit.categoryId, additional_category_ids: topicEdit.additionalCategoryIds }),
      });
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setTopicEdit(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update topics");
    } finally {
      setTopicSaving(false);
    }
  };

  const setExcluded = async (item: Transaction, excluded: boolean) => {
    setExclusionBusy(item.id);
    setError("");
    try {
      const updated = await apiRequest<Transaction>(`/api/transactions/${item.id}/exclusion`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded }),
      });
      setItems((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      if (excluded) {
        if (topicEdit?.transactionId === item.id) setTopicEdit(null);
        setExcludeCandidate(null);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update transaction exclusion");
    } finally {
      setExclusionBusy(null);
    }
  };

  const hasFilters = Boolean(name || topicId || startDate || endDate);
  const filteredTotal = items.reduce((total, item) => total + Math.round(item.amount * 100), 0) / 100;
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
    <section className="panel full-list"><div className="table-title"><div><ReceiptText /><span>{loading ? "Finding transactions…" : `${items.length} ${items.length === 1 ? "transaction" : "transactions"}`}</span></div>{filtersApplied && !loading && <div className="filtered-total"><span>Filtered total</span><strong className={filteredTotal >= 0 ? "income" : ""}>{signedEuro(filteredTotal)}</strong></div>}</div>{!loading && (items.length ? <div className="transaction-list">{items.map((item) => <div className="transaction-edit-entry" key={item.id}><TransactionRow item={item} showStatus action={<div className="transaction-actions">{item.status !== "excluded" && <button className="edit-transaction-topics" aria-label={`Edit transaction details for ${item.merchant}`} title="Edit transaction details" onClick={() => editTopics(item)}><Tags /></button>}{item.status !== "excluded" && <button className="exclude-transaction" aria-label={`Exclude ${item.merchant}`} data-tooltip="Exclude" disabled={exclusionBusy === item.id} onClick={() => setExcludeCandidate(item)}>{exclusionBusy === item.id ? <LoaderCircle className="spinner" /> : <Ban />}</button>}{item.status === "excluded" && item.exclusion_reason === "manual" && <button className="restore-transaction" aria-label={`Restore ${item.merchant}`} title="Restore to analytics" disabled={exclusionBusy === item.id} onClick={() => void setExcluded(item, false)}>{exclusionBusy === item.id ? <LoaderCircle className="spinner" /> : <RotateCcw />}</button>}</div>} />{topicEdit?.transactionId === item.id && <div className="transaction-topic-editor"><label className="transaction-description-editor"><span>Description</span><textarea aria-label={`Edited description for ${item.merchant}`} maxLength={160} placeholder="Add a short description" value={topicEdit.description} onChange={(event) => setTopicEdit({ ...topicEdit, description: event.target.value })} /></label><TopicAssignmentPicker categories={categories} primaryId={topicEdit.categoryId} contextIds={topicEdit.additionalCategoryIds} label={item.merchant} onPrimary={(categoryId) => setTopicEdit({ ...topicEdit, categoryId, additionalCategoryIds: topicEdit.additionalCategoryIds.filter((id) => id !== categoryId) })} onContext={toggleEditTopic} /><div className="transaction-topic-actions"><button className="cancel-topic-edit" disabled={topicSaving} onClick={() => setTopicEdit(null)}>Cancel</button><button disabled={topicSaving || !topicEdit.description.trim() || !topicEdit.categoryId} onClick={() => void saveTopics()}>{topicSaving ? <LoaderCircle className="spinner" /> : <Check />}Save changes</button></div></div>}</div>)}</div> : <div className="no-filter-results"><Search /><strong>No matching transactions</strong><span>Try clearing or broadening a filter.</span></div>)}</section>
    {excludeCandidate && <ExclusionDialog item={excludeCandidate} busy={exclusionBusy === excludeCandidate.id} onCancel={() => setExcludeCandidate(null)} onConfirm={() => void setExcluded(excludeCandidate, true)} />}
  </div>;
}

function TransactionRows({ items, showStatus = false }: { items: Transaction[]; showStatus?: boolean }) {
  return <div className="transaction-list">{items.map((item) => <TransactionRow item={item} key={item.id} showStatus={showStatus} />)}</div>;
}

function TransactionRow({ item, showStatus = false, action }: { item: Transaction; showStatus?: boolean; action?: React.ReactNode }) {
  const primaryTopic = item.category || item.proposed_category || item.exclusion_reason?.replaceAll("_", " ") || "Pending review";
  const contextTopics = item.additional_categories.length ? item.additional_categories : item.proposed_additional_categories;
  return <div className={`transaction ${action ? "with-action" : ""}`}><div className="merchant-icon">{item.merchant.charAt(0)}</div><div className="transaction-main"><strong>{item.merchant}</strong><span>{new Date(`${item.date}T00:00:00`).toLocaleDateString("en", { day: "numeric", month: "short" })}</span></div><div className="transaction-topics"><span className="category-pill" aria-label={`Primary topic: ${primaryTopic}`}><i style={{ background: item.category_color }} />{primaryTopic}</span>{contextTopics.map((topic) => <span className="context-topic-pill" key={topic.id}>{topic.name}</span>)}</div>{showStatus && <span className={`status ${item.status}`}>{item.status}</span>}<strong className={item.amount >= 0 ? "amount income" : "amount"}>{signedEuro(item.amount)}</strong>{action}</div>;
}

function TopicAssignmentPicker({ categories, primaryId, contextIds, label, onPrimary, onContext }: { categories: Category[]; primaryId: number | null; contextIds: number[]; label: string; onPrimary: (categoryId: number) => void; onContext: (categoryId: number) => void }) {
  const primary = categories.find((topic) => topic.id === primaryId);
  const summary = primary ? `${primary.name}${contextIds.length ? ` + ${contextIds.length} context` : ""}` : "Choose topics";
  return <details className="topic-assignment-picker"><summary><span>Topics</span><strong>{summary}</strong></summary><div className="topic-assignment-menu"><div className="topic-assignment-head"><span>Topic</span><span>Primary</span><span>Context</span></div>{taxonomyRows(categories).map(({ topic, depth }) => <div className="topic-assignment-row" key={topic.id}><span style={{ paddingLeft: depth * 14 }}>{topic.name}</span><label className="primary-topic-choice"><input type="radio" name={`primary-${label}`} aria-label={`Set ${topic.name} as primary for ${label}`} checked={primaryId === topic.id} onChange={() => onPrimary(topic.id)} /><span>Primary</span></label><label className="context-topic-choice"><input type="checkbox" aria-label={`Use ${topic.name} as context for ${label}`} checked={contextIds.includes(topic.id)} disabled={primaryId === topic.id} onChange={() => onContext(topic.id)} /><span>Context</span></label></div>)}</div></details>;
}

type ReviewDraft = { description: string; categoryId: number | null; additionalCategoryIds: number[] };
type Approval = { transaction_id: number; description: string; category_id: number; additional_category_ids: number[] };
const blankDraft = (): ReviewDraft => ({ description: "", categoryId: null, additionalCategoryIds: [] });

function ReviewQueue({ items, categories, onApprove, onExclude, onClassify, onTopicsChanged, busy }: { items: Transaction[]; categories: Category[]; onApprove: (items: Approval[]) => Promise<void>; onExclude: (item: Transaction) => Promise<void>; onClassify: () => Promise<void>; onTopicsChanged: () => Promise<void>; busy: boolean }) {
  const [drafts, setDrafts] = useState<Record<number, ReviewDraft>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState("confidence-asc");
  const [customNames, setCustomNames] = useState<Record<number, string>>({});
  const [customParents, setCustomParents] = useState<Record<number, string>>({});
  const [codexInstructions, setCodexInstructions] = useState<Record<number, string>>({});
  const [proposals, setProposals] = useState<Record<number, TopicProposal>>({});
  const [topicBusy, setTopicBusy] = useState<number | null>(null);
  const [topicErrors, setTopicErrors] = useState<Record<number, string>>({});
  const [topicCreatorVersions, setTopicCreatorVersions] = useState<Record<number, number>>({});
  const [reviewError, setReviewError] = useState("");
  const [excludeBusy, setExcludeBusy] = useState<number | null>(null);
  const [excludeCandidate, setExcludeCandidate] = useState<Transaction | null>(null);
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
    if (sort === "date-asc") return left.date.localeCompare(right.date);
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
      setReviewError("Add a short description and topic before approving");
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

  const exclude = async (item: Transaction) => {
    setExcludeBusy(item.id);
    setReviewError("");
    try {
      await onExclude(item);
      setExcludeCandidate(null);
      setSelected((current) => { const next = new Set(current); next.delete(item.id); return next; });
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "Unable to exclude transaction");
    } finally {
      setExcludeBusy(null);
    }
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
      setTopicCreatorVersions((current) => ({ ...current, [transactionId]: (current[transactionId] ?? 0) + 1 }));
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
      setTopicCreatorVersions((current) => ({ ...current, [transactionId]: (current[transactionId] ?? 0) + 1 }));
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
        <select aria-label="Sort review queue" value={sort} onChange={(event) => setSort(event.target.value)}><option value="confidence-asc">Lowest confidence first</option><option value="confidence-desc">Highest confidence first</option><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option></select>
        <button className="secondary-review-action" onClick={() => void runCodex()} disabled={busy}>{busy ? <LoaderCircle className="spinner" /> : <Sparkles />}Ask Codex</button>
        <button onClick={() => void approve(sortedItems.filter((item) => selected.has(item.id)))} disabled={busy || !selected.size}><Check />Approve selected ({selected.size})</button>
      </div>
    </div>
    <div className="review-batch-bar"><label><input type="checkbox" checked={selected.size === items.length} onChange={(event) => setSelected(event.target.checked ? new Set(items.map((item) => item.id)) : new Set())} />Select all</label><span>{items.filter(ready).length} ready</span><button onClick={() => void approve(items.filter(ready))} disabled={busy || !items.some(ready)}>Approve all ready</button></div>
    <div className="review-table">
      <div className="review-table-head"><span /><span>Transaction</span><span>Codex description</span><span>Primary & context topics</span><span>Confidence</span><span>Actions</span></div>
      {sortedItems.map((item) => <div className={`review-row ${selected.has(item.id) ? "selected" : ""}`} key={item.id}>
        <input aria-label={`Select ${item.merchant}`} type="checkbox" checked={selected.has(item.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(item.id) : next.delete(item.id); return next; })} />
        <div className="review-transaction"><div><span className="merchant-icon">{item.merchant.charAt(0)}</span><div><strong>{item.merchant}</strong><small className={item.amount >= 0 ? "credit" : ""}>{shortDate(item.date)} · {signedEuro(item.amount)}</small></div></div><p title={item.description}>{item.description}</p></div>
        <textarea aria-label={`Description for ${item.merchant}`} rows={2} maxLength={160} placeholder="Ask Codex or write a short description" value={drafts[item.id]?.description ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...(current[item.id] ?? blankDraft()), description: event.target.value } }))} />
        <div className="review-topic-field"><TopicAssignmentPicker categories={categories} primaryId={drafts[item.id]?.categoryId ?? null} contextIds={drafts[item.id]?.additionalCategoryIds ?? []} label={item.merchant} onPrimary={(categoryId) => setPrimaryTopic(item.id, categoryId)} onContext={(categoryId) => toggleAdditionalTopic(item.id, categoryId)} /><details key={`${item.id}-${topicCreatorVersions[item.id] ?? 0}`}><summary>Add a new topic</summary><div className="topic-creation-options"><div className="topic-creation-option"><span>Add directly</span><input aria-label={`New topic name for ${item.merchant}`} placeholder="Specific topic name" value={customNames[item.id] ?? ""} onChange={(event) => setCustomNames({ ...customNames, [item.id]: event.target.value })} /><select aria-label={`Parent for new topic on ${item.merchant}`} value={customParents[item.id] ?? ""} onChange={(event) => setCustomParents({ ...customParents, [item.id]: event.target.value })}><option value="">Root topic</option>{topicRows.map(({ topic, depth }) => <option key={topic.id} value={topic.id}>{topicLabel(topic.name, depth)}</option>)}</select><button disabled={topicBusy !== null || !customNames[item.id]?.trim()} onClick={() => void createCustom(item.id)}><Plus />Add topic</button></div><div className="topic-creation-option codex-topic-option"><span>Plan with Codex</span><textarea aria-label={`Taxonomy request for ${item.merchant}`} maxLength={1000} placeholder="Explain why you need a new topic and how the current topics should be reorganized, if needed." value={codexInstructions[item.id] ?? ""} onChange={(event) => setCodexInstructions({ ...codexInstructions, [item.id]: event.target.value })} /><button disabled={topicBusy !== null || !codexInstructions[item.id]?.trim()} onClick={() => void proposeCustom(item.id)}>{topicBusy === item.id && !proposals[item.id] ? <LoaderCircle className="spinner" /> : <Sparkles />}Make proposal</button>{proposals[item.id] && <InlineTopicProposal proposal={proposals[item.id]} busy={topicBusy === item.id} onApply={() => void applyProposal(item.id)} onReject={() => void rejectProposal(item.id)} />}</div></div>{topicErrors[item.id] && <p className="inline-topic-error">{topicErrors[item.id]}</p>}</details></div>
        <span className={`confidence ${item.confidence === null ? "unknown" : item.confidence < .65 ? "low" : item.confidence < .85 ? "medium" : "high"}`}>{item.confidence === null ? "Not scored" : `${Math.round(item.confidence * 100)}%`}</span>
        <div className="review-row-actions"><button className="exclude-row-action" aria-label={`Exclude ${item.merchant}`} data-tooltip="Exclude" disabled={busy || excludeBusy === item.id} onClick={() => setExcludeCandidate(item)}>{excludeBusy === item.id ? <LoaderCircle className="spinner" /> : <Ban />}</button><button className="approve-row-action" aria-label={`Approve ${item.merchant}`} title="Approve transaction" disabled={busy || !ready(item)} onClick={() => void approve([item])}><Check /></button></div>
      </div>)}
    </div>
    {excludeCandidate && <ExclusionDialog item={excludeCandidate} busy={excludeBusy === excludeCandidate.id} onCancel={() => setExcludeCandidate(null)} onConfirm={() => void exclude(excludeCandidate)} />}
  </div>;
}

function ExclusionDialog({ item, busy, onCancel, onConfirm }: { item: Transaction; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}><section className="exclusion-dialog" role="dialog" aria-modal="true" aria-labelledby="exclusion-title"><div className="exclusion-dialog-icon"><Ban /></div><p className="eyebrow">EXCLUDE TRANSACTION</p><h2 id="exclusion-title">Remove from spending analytics?</h2><p><strong>{item.merchant}</strong> will no longer appear in totals, charts, or activity. You can restore it later from Transactions.</p><div className="exclusion-dialog-actions"><button onClick={onCancel} disabled={busy}>Keep transaction</button><button className="confirm-exclusion" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="spinner" /> : <Ban />}Exclude</button></div></section></div>,
    document.body,
  );
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
