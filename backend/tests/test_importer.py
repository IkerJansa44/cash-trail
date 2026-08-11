from decimal import Decimal

import pytest

from app.importer import normalize_merchant, parse_file

# All dates, merchants, card suffixes, references, amounts, and balances below
# are synthetic test data, not copied from a personal bank statement.


def test_parses_bank_html_export() -> None:
    content = """<html><table>
    <tr><td></td><td>DATA D'OPERACIÓ</td><td>CONCEPTE</td><td>DATA VALOR</td><td>IMPORT</td><td>SALDO</td></tr>
    <tr><td></td><td>10/01/2020</td><td>TARGETA *0000 EXAMPLE SOFTWARE#G000000001</td><td>08/01/2020</td><td>-12,50</td><td>1.000,00</td></tr>
    </table></html>""".encode("windows-1252")

    statement = parse_file("statement.xls", content)
    transactions = statement.transactions

    assert len(transactions) == 1
    assert transactions[0].amount == Decimal("-12.50")
    assert transactions[0].balance == Decimal("1000.00")
    assert transactions[0].merchant == "EXAMPLE SOFTWARE"
    assert transactions[0].currency == "EUR"
    assert statement.coverage_start.isoformat() == "2020-01-10"
    assert statement.coverage_end.isoformat() == "2020-01-10"
    assert statement.coverage_source == "transactions"


def test_rejects_non_euro_currency() -> None:
    content = """<html><table>
    <tr><td>FECHA OPERACIÓN</td><td>CONCEPTO</td><td>IMPORTE</td><td>MONEDA</td></tr>
    <tr><td>10/01/2020</td><td>EXAMPLE SHOP</td><td>-10,00</td><td>USD</td></tr>
    </table></html>""".encode("windows-1252")

    with pytest.raises(ValueError, match="Only EUR"):
        parse_file("statement.xls", content)


def test_normalizes_known_bank_prefixes() -> None:
    assert normalize_merchant("TARGETA *0000 EXAMPLE RIDE") == "EXAMPLE RIDE"
    assert normalize_merchant("TARGETA *0000 Example.shop order 000001") == "EXAMPLE.SHOP"


def test_uses_queried_statement_range_when_present() -> None:
    content = """<html><table>
    <tr><td>Data des de</td><td>11/01/2020</td></tr>
    <tr><td>Data fins a</td><td>16/01/2020</td></tr>
    <tr><td>DATA D'OPERACIÓ</td><td>CONCEPTE</td><td>IMPORT</td></tr>
    <tr><td>13/01/2020</td><td>EXAMPLE SHOP</td><td>-10,00</td></tr>
    </table></html>""".encode("windows-1252")

    statement = parse_file("statement.xls", content)

    assert statement.coverage_start.isoformat() == "2020-01-11"
    assert statement.coverage_end.isoformat() == "2020-01-16"
    assert statement.coverage_source == "queried_range"


def test_preserves_repeated_identical_transactions() -> None:
    content = """<html><table>
    <tr><td>FECHA OPERACIÓN</td><td>CONCEPTO</td><td>FECHA VALOR</td><td>IMPORTE</td><td>SALDO</td></tr>
    <tr><td>04/01/2020</td><td>TARGETA *0000 EXAMPLE CAFE</td><td>04/01/2020</td><td>-25,00</td><td>975,00</td></tr>
    <tr><td>04/01/2020</td><td>ANUL.TARGETA *0000 EXAMPLE CAFE</td><td>04/01/2020</td><td>25,00</td><td>1.000,00</td></tr>
    <tr><td>04/01/2020</td><td>TARGETA *0000 EXAMPLE CAFE</td><td>04/01/2020</td><td>-25,00</td><td>975,00</td></tr>
    </table></html>""".encode("windows-1252")

    transactions = parse_file("statement.xls", content).transactions

    assert len(transactions) == 3
    assert len({item.fingerprint for item in transactions}) == 3
    assert [item.amount for item in transactions] == [
        Decimal("-25.00"),
        Decimal("25.00"),
        Decimal("-25.00"),
    ]
