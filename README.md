# Cash Trail

A private, single-user spending dashboard for local bank-statement analysis. Cash Trail imports the
`.xls` HTML export used by the supplied bank as well as genuine `.xlsx` workbooks, fingerprints
transactions, excludes payroll and account transfers, and learns merchant topic hints from
corrections. Other positive credits are reviewed and subtract from net spending in their approved
topic and transaction date; category or period totals may therefore be negative.
It also tracks the date coverage of every statement, warns about gaps between imports, and supports
inclusive custom date ranges for spending totals and category breakdowns.
The overview has no global month selector: clicking a column in the monthly spending chart opens
that month's totals, comparison, category breakdown, and complete transaction list inline.

When a bank export includes queried `from` and `to` dates, those are used as the authoritative
coverage range. If they are omitted, Cash Trail falls back to the earliest and latest transaction
dates in that file. A fallback range cannot distinguish a no-transaction day from a missing day
inside the same export.

Every expense, refund, and repayment is reviewed through the Codex CLI. Codex writes a short
description, proposes one primary leaf topic plus optional contextual leaf topics, and assigns a
confidence score. Nothing is accepted automatically: proposals enter a confidence-sortable queue
where descriptions and topics can be edited and approved in batches. Only the primary topic
allocates money in totals and stacked columns, so contextual topics never double-count spending.
All selected topics remain searchable and are learned as merchant hints. Live web search is enabled
so ambiguous merchants can be researched before classification. Categorized dashboards update
after approval; pending activity remains visible as such.

Spending topics support arbitrary-depth parent/child relationships. Transactions attach to leaf
topics and analytics roll their spending up to the root. The Topics tab supports rename, move,
merge, and parent-preserving deletion. Its Structure tree supports dragging a topic onto another
topic to group it or onto the top-level drop zone to remove its parent. A custom topic is created
exactly as named under the parent the user selects and is immediately available to the transaction
being reviewed. From the same
transaction card, the user can instead explain why a new topic is needed and how the taxonomy
should change. Codex proposes reuse, placement, or restructuring for inline confirmation and
selects the resulting leaf topic when the proposal is approved.

## Run locally

```bash
docker compose build
docker compose run --rm backend codex login --device-auth
docker compose up
```

Open [http://localhost:3000](http://localhost:3000). The dashboard and database are stored in Docker
volumes and remain on this computer.

The Codex login is persisted in the `codex-home` volume. It can use the Codex allowance associated
with an eligible ChatGPT account; it is not an OpenAI API integration.

## Configuration

Copy `.env.example` to `.env` to change the Codex CLI timeout.

## Development checks

```bash
uv run --with-requirements backend/requirements.txt --with pytest --with httpx pytest backend/tests -v
uv run --with ruff ruff format backend
uv run --with ruff ruff check backend
cd frontend && npm install && npm run build
```
