import hashlib
import io
import re
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path

from openpyxl import load_workbook

HEADER_ALIASES = {
    "operation_date": {"DATA D'OPERACIÓ", "FECHA OPERACIÓN", "FECHA OPERACION"},
    "description": {"CONCEPTE", "CONCEPTO", "DESCRIPCIÓN", "DESCRIPCION"},
    "value_date": {"DATA VALOR", "FECHA VALOR"},
    "amount": {"IMPORT", "IMPORTE"},
    "balance": {"SALDO"},
    "currency": {"MONEDA", "DIVISA", "CURRENCY"},
}


@dataclass(frozen=True)
class ImportedTransaction:
    operation_date: date
    description: str
    value_date: date | None
    amount: Decimal
    balance: Decimal | None
    currency: str
    merchant: str
    fingerprint: str


@dataclass(frozen=True)
class ParsedStatement:
    transactions: list[ImportedTransaction]
    coverage_start: date
    coverage_end: date
    coverage_source: str


class BankHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self._row = []
        elif tag == "td" and self._row is not None:
            self._cell = []

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "td" and self._row is not None and self._cell is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None


def normalize_merchant(description: str) -> str:
    value = description.upper().strip()
    prefixes = (
        r"^TARGETA\s+\*\d+\s+",
        r"^ANUL\.TARGETA\s+\*\d+\s+",
        r"^DEVOLUCIO\s+TARG\.\s+\*\d+\s+",
        r"^CAIXER\s+TARG\.\s+\*\d+\s+",
    )
    for prefix in prefixes:
        value = re.sub(prefix, "", value)
    value = re.sub(r"[#-]?[A-Z]?\d{7,}$", "", value)
    value = re.sub(r"\bORDER\s+\d+\b", "", value)
    value = re.sub(r"\s+", " ", value).strip(" -#")
    return value[:200]


def parse_file(filename: str, content: bytes) -> ParsedStatement:
    suffix = Path(filename).suffix.lower()
    if suffix not in {".xls", ".xlsx"}:
        raise ValueError("Only .xls and .xlsx files are supported")
    rows = _parse_html(content) if _looks_like_html(content) else _parse_xlsx(content)
    transactions = _number_repeated_transactions(
        [_to_transaction(row) for row in _extract_rows(rows)]
    )
    if not transactions:
        raise ValueError("The statement does not contain transactions")
    queried_range = _extract_queried_range(rows)
    if queried_range:
        return ParsedStatement(transactions, *queried_range, "queried_range")
    dates = [item.operation_date for item in transactions]
    return ParsedStatement(transactions, min(dates), max(dates), "transactions")


def _looks_like_html(content: bytes) -> bool:
    return b"<html" in content[:1000].lower()


def _parse_html(content: bytes) -> list[list[str]]:
    parser = BankHtmlParser()
    parser.feed(content.decode("windows-1252"))
    return parser.rows


def _parse_xlsx(content: bytes) -> list[list[str]]:
    try:
        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception as exc:
        raise ValueError("The Excel file could not be read") from exc
    rows = [
        ["" if value is None else str(value) for value in row] for row in workbook.active.values
    ]
    return rows


def _extract_queried_range(rows: list[list[str]]) -> tuple[date, date] | None:
    labels = {
        "start": {"DATA DES DE", "FECHA DESDE", "DESDE"},
        "end": {"DATA FINS A", "FECHA HASTA", "HASTA"},
    }
    values: dict[str, date] = {}
    for row in rows:
        for index, cell in enumerate(row[:-1]):
            normalized = str(cell).strip().upper()
            for name, aliases in labels.items():
                if normalized in aliases and str(row[index + 1]).strip():
                    values[name] = _parse_date(row[index + 1])
    if {"start", "end"} != values.keys() or values["start"] > values["end"]:
        return None
    return values["start"], values["end"]


def _extract_rows(rows: list[list[str]]) -> list[dict[str, object]]:
    for index, row in enumerate(rows):
        normalized = [str(cell).strip().upper() for cell in row]
        if any(cell in HEADER_ALIASES["operation_date"] for cell in normalized):
            columns = _map_columns(normalized)
            return [
                {
                    name: row_values[position] if position < len(row_values) else ""
                    for name, position in columns.items()
                }
                for row_values in rows[index + 1 :]
                if _is_transaction_row(row_values, columns)
            ]
    raise ValueError("No supported transaction table was found")


def _map_columns(header: list[str]) -> dict[str, int]:
    columns = {
        name: index
        for index, value in enumerate(header)
        for name, aliases in HEADER_ALIASES.items()
        if value in aliases
    }
    required = {"operation_date", "description", "amount"}
    if not required.issubset(columns):
        raise ValueError("The transaction table is missing required columns")
    return columns


def _is_transaction_row(row: list[str], columns: dict[str, int]) -> bool:
    date_index = columns["operation_date"]
    return date_index < len(row) and bool(str(row[date_index]).strip())


def _to_transaction(row: dict[str, object]) -> ImportedTransaction:
    operation_date = _parse_date(row["operation_date"])
    value_date = _parse_date(row.get("value_date")) if row.get("value_date") else None
    description = str(row["description"]).strip()
    amount = _parse_decimal(row["amount"])
    balance = _parse_decimal(row["balance"]) if row.get("balance") else None
    currency = str(row.get("currency") or "EUR").strip().upper()
    if currency not in {"EUR", "€"}:
        raise ValueError(f"Unsupported currency: {currency}. Only EUR is accepted")
    merchant = normalize_merchant(description)
    raw_fingerprint = "|".join(
        [
            operation_date.isoformat(),
            value_date.isoformat() if value_date else "",
            merchant,
            str(amount),
            str(balance or ""),
        ]
    )
    return ImportedTransaction(
        operation_date=operation_date,
        description=description,
        value_date=value_date,
        amount=amount,
        balance=balance,
        currency="EUR",
        merchant=merchant,
        fingerprint=hashlib.sha256(raw_fingerprint.encode()).hexdigest(),
    )


def _number_repeated_transactions(
    transactions: list[ImportedTransaction],
) -> list[ImportedTransaction]:
    occurrences: dict[str, int] = defaultdict(int)
    numbered = []
    for transaction in transactions:
        occurrences[transaction.fingerprint] += 1
        occurrence = occurrences[transaction.fingerprint]
        if occurrence == 1:
            numbered.append(transaction)
            continue
        fingerprint = hashlib.sha256(f"{transaction.fingerprint}|{occurrence}".encode()).hexdigest()
        numbered.append(replace(transaction, fingerprint=fingerprint))
    return numbered


def _parse_date(value: object) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip().split(" ")[0]
    try:
        if "/" in text:
            day, month, year = map(int, text.split("/"))
            return date(year, month, day)
        return date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"Invalid transaction date: {value}") from exc


def _parse_decimal(value: object) -> Decimal:
    if isinstance(value, (int, float, Decimal)):
        return Decimal(str(value)).quantize(Decimal("0.01"))
    text = str(value).strip().replace("€", "").replace(" ", "")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    try:
        return Decimal(text).quantize(Decimal("0.01"))
    except InvalidOperation as exc:
        raise ValueError(f"Invalid amount: {value}") from exc
