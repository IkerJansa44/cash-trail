# Cash Trail

A private, single-user spending dashboard for local bank-statement analysis. Cash Trail imports the
`.xls` HTML export used by the supplied bank as well as genuine `.xlsx` workbooks, fingerprints
transactions with occurrence-aware handling for repeated identical rows, excludes payroll and
account transfers, and learns merchant topic hints from
corrections. Other positive credits are reviewed and subtract from net spending in their approved
topic and transaction date; category or period totals may therefore be negative.
It also tracks the date coverage of every statement, warns about gaps between imports, and supports
inclusive custom date ranges for spending totals and topic breakdowns.
The overview switches its monthly chart and spending breakdown between topics and labels. The label
view groups transactions without a label as "Unlabeled," so both views cover the same spending.
Selecting a chart column or month label shows that month's spending in the existing pie breakdown
and recent transactions list. The main chart and summary cards continue to show the overview range.
Clicking topic or label names beneath the chart isolates those series and their net total; click
another name to include it, click a selected name to remove it, or press Escape to clear filters.

When a bank export includes queried `from` and `to` dates, those are used as the authoritative
coverage range. If they are omitted, Cash Trail falls back to the earliest and latest transaction
dates in that file. A fallback range cannot distinguish a no-transaction day from a missing day
inside the same export.

Every expense, refund, and repayment is reviewed through the Codex CLI. Codex writes a short
description, proposes one primary topic plus optional contextual topics, and assigns a
confidence score. Nothing is accepted automatically: proposals enter a confidence-sortable queue
where descriptions and topics can be edited and approved in batches. Only the primary topic
allocates money in totals and stacked columns, so contextual topics never double-count spending.
All selected topics remain searchable and are learned as merchant hints. Live web search is enabled
so ambiguous merchants can be researched before classification. Categorized dashboards update
after approval; pending activity remains visible as such.
Descriptions, primary and context topics, and labels can also be edited from the Transactions tab
or the overview's Recent transactions list.
Each transaction can also carry one optional free-text label, separate from the topic taxonomy.
The topic picker suggests recently used labels when its label field receives focus.

Spending topics support arbitrary-depth parent/child relationships. Transactions may attach to any
topic and analytics roll their spending up to the root. The Topics tab supports rename, move,
merge, and parent-preserving deletion. Its Structure tree supports dragging a topic onto another
topic to group it or onto the top-level drop zone to remove its parent. A custom topic is created
exactly as named under the parent the user selects and is immediately available to the transaction
being reviewed. From the same
transaction card, the user can instead explain why a new topic is needed and how the taxonomy
should change. Codex proposes reuse, placement, or restructuring for inline confirmation and
selects the resulting topic when the proposal is approved.

## Run locally

```bash
docker compose build
docker compose run --rm backend codex login --device-auth
docker compose up
```

Open [http://localhost:3000/cash-trail/](http://localhost:3000/cash-trail/). The dashboard and database are stored in Docker
volumes and remain on this computer.

The Codex login is persisted in the `codex-home` volume. It can use the Codex allowance associated
with an eligible ChatGPT account; it is not an OpenAI API integration.

## Configuration

Copy `.env.example` to `.env` to change the Codex CLI timeout or configure iPhone notifications.

### iPhone notifications

Cash Trail is an installable PWA with standards-based Web Push. Create one VAPID P-256 key pair,
keep it stable between deployments, and set `WEB_PUSH_VAPID_PUBLIC_KEY`,
`WEB_PUSH_VAPID_PRIVATE_KEY`, and `WEB_PUSH_VAPID_SUBJECT` in `.env`. The subject must be a monitored
`mailto:` address or an HTTPS contact URL. The private key must never be exposed to the frontend or
committed.

The iPhone must reach Cash Trail through HTTPS; an HTTP LAN address is not sufficient. Open that
HTTPS origin in Safari, choose **Share → Add to Home Screen**, launch Cash Trail from its Home Screen
icon, open **Notifications**, and tap **Enable on this device**. Permission is requested only from
that tap. Use **Send test** to verify server-to-device delivery before adding automatic alert rules.

Cash Trail has no email notification channel. The test route is the manual sender. At 20:00
Europe/Madrid on the final day of each month, the backend also sends one
deduplicated reminder when no statement import was recorded during that calendar month. Failed push
deliveries remain retryable during the evening. If the Mac or backend was unavailable, the same
deduplicated check catches up during the first seven days of the next month. Override the hour and
timezone with `MONTH_END_IMPORT_REMINDER_HOUR` and `NOTIFICATION_TIMEZONE`.

## Development checks

```bash
uv run --with-requirements backend/requirements.txt --with pytest --with httpx pytest backend/tests -v
uv run --with ruff ruff format backend
uv run --with ruff ruff check backend
cd frontend && npm install && npm run build
```
