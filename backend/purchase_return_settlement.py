from sqlmodel import select

from backend.models import Purchase, PurchasePayment, PurchaseReturn


def round2(value: float) -> float:
    return float(f"{float(value or 0):.2f}")


def recalculate_purchase_return_settlements(session, purchase: Purchase) -> list[PurchaseReturn]:
    """Allocate returns between unpaid credit, paid refunds, and write-off reversals."""
    payments = session.exec(
        select(PurchasePayment).where(
            PurchasePayment.purchase_id == purchase.id,
            PurchasePayment.is_deleted == False,  # noqa: E712
        )
    ).all()
    returns = session.exec(
        select(PurchaseReturn).where(
            PurchaseReturn.purchase_id == purchase.id,
            PurchaseReturn.is_deleted == False,  # noqa: E712
        )
    ).all()

    events = []
    for payment in payments:
        events.append((str(payment.paid_at or "")[:10], 0, int(payment.id or 0), "PAYMENT", payment))
    for purchase_return in returns:
        events.append((str(purchase_return.return_date or "")[:10], 1, int(purchase_return.id or 0), "RETURN", purchase_return))
    events.sort(key=lambda event: (event[0], event[1], event[2]))

    liability = round2(purchase.total_amount)
    cash_available = 0.0
    online_available = 0.0
    writeoff_available = 0.0
    changed: list[PurchaseReturn] = []

    for _date, _order, _id, event_type, row in events:
        if event_type == "PAYMENT":
            amount = round2(row.amount)
            liability = round2(liability - amount)
            if bool(row.is_writeoff):
                writeoff_available = round2(writeoff_available + amount)
                continue
            cash = round2(row.cash_amount)
            online = round2(row.online_amount)
            if cash <= 0 and online <= 0:
                cash = amount
            cash_available = round2(cash_available + cash)
            online_available = round2(online_available + online)
            continue

        return_total = round2(row.total_amount)
        unpaid_credit = round2(min(return_total, max(0.0, liability)))
        settlement_needed = round2(max(0.0, return_total - unpaid_credit))
        refund_cash = round2(min(settlement_needed, cash_available))
        settlement_needed = round2(settlement_needed - refund_cash)
        refund_online = round2(min(settlement_needed, online_available))
        settlement_needed = round2(settlement_needed - refund_online)
        writeoff_reversal = round2(min(settlement_needed, writeoff_available))

        cash_available = round2(cash_available - refund_cash)
        online_available = round2(online_available - refund_online)
        writeoff_available = round2(writeoff_available - writeoff_reversal)
        settled_back = round2(refund_cash + refund_online + writeoff_reversal)
        liability = round2(liability - return_total + settled_back)

        if (
            round2(row.refund_cash) != refund_cash
            or round2(row.refund_online) != refund_online
            or round2(row.writeoff_reversal) != writeoff_reversal
        ):
            row.refund_cash = refund_cash
            row.refund_online = refund_online
            row.writeoff_reversal = writeoff_reversal
            session.add(row)
            changed.append(row)

    for row in session.exec(
        select(PurchaseReturn).where(
            PurchaseReturn.purchase_id == purchase.id,
            PurchaseReturn.is_deleted == True,  # noqa: E712
        )
    ).all():
        if round2(row.refund_cash) or round2(row.refund_online) or round2(row.writeoff_reversal):
            row.refund_cash = 0.0
            row.refund_online = 0.0
            row.writeoff_reversal = 0.0
            session.add(row)
            changed.append(row)

    return changed


def purchase_return_settlement_total(row: PurchaseReturn) -> float:
    return round2(row.refund_cash + row.refund_online + row.writeoff_reversal)
