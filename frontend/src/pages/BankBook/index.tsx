import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableFooter,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import CloseIcon from '@mui/icons-material/Close'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createBankbookEntry,
  deleteBankbookEntry,
  getBankbookDailySummary,
  getBankbookDay,
  listBankbookEntries,
  updateBankbookEntry,
  type BankbookMode,
  type BankbookType,
} from '../../services/bankbook'
import { listCashbookEntries } from '../../services/cashbook'
import { getBill, listPayments } from '../../services/billing'
import { listPurchasePayments } from '../../services/purchases'
import { listExchangeRecords, listReturns } from '../../services/returns'
import { toYMD } from '../../lib/date'
import BillEditDialog from '../../components/billing/BillEditDialog'
import BillPaymentsPanel from '../../components/billing/BillPaymentsPanel'
import { fetchFinancialYears } from '../../services/settings'
import { financialYearDisplayName } from '../../lib/financialYear'

function money(n: number | string | null | undefined) {
  return Number(n || 0).toFixed(2)
}

function errorMessage(err: any, fallback: string) {
  return String(err?.response?.data?.detail || err?.message || fallback)
}

function isoDate(s: string | null | undefined) {
  const v = String(s || '')
  return v.length >= 10 ? v.slice(0, 10) : '-'
}

function isoTime(s: string | null | undefined) {
  const v = String(s || '')
  return v.length >= 19 ? v.slice(11, 19) : '-'
}

function addDays(ymd: string, days: number) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  dt.setDate(dt.getDate() + days)
  return toYMD(dt)
}

function addMonths(ymd: string, months: number) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  dt.setMonth(dt.getMonth() + months)
  return toYMD(dt)
}

function weekRange(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  const day = dt.getDay()
  const diffToMonday = day === 0 ? -6 : 1 - day
  const start = new Date(dt)
  start.setDate(dt.getDate() + diffToMonday)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return { from: toYMD(start), to: toYMD(end) }
}

function monthRange(ymd: string) {
  const [y, m] = ymd.split('-').map(Number)
  const start = new Date(y, (m || 1) - 1, 1)
  const end = new Date(y, (m || 1), 0)
  return { from: toYMD(start), to: toYMD(end) }
}

function typeChipProps(type: string) {
  const baseSx = { minWidth: 84, height: 24, fontWeight: 700, justifyContent: 'center' as const }
  const t = String(type || '').toUpperCase()
  if (t === 'OPENING') return { label: 'Opening', sx: { ...baseSx, bgcolor: 'info.light', color: 'info.dark' } }
  if (t === 'RETURN') return { label: 'Refund', sx: { ...baseSx, bgcolor: 'warning.light', color: 'warning.dark' } }
  if (t === 'SPLIT') return { label: 'Split', sx: { ...baseSx, bgcolor: '#9fe3b0', color: '#124b19' } }
  if (t === 'PAYMENT') return { label: 'Payment', sx: { ...baseSx, bgcolor: '#e0f2fe', color: '#075985' } }
  if (t === 'CONTRA') return { label: 'Contra', sx: { ...baseSx, bgcolor: '#c7d2fe', color: '#1e3a8a' } }
  if (t === 'RECEIPT') return { label: 'Receipt', sx: { ...baseSx, bgcolor: 'success.light', color: 'success.dark' } }
  if (t === 'WITHDRAWAL') return { label: 'Withdrawal', sx: { ...baseSx, bgcolor: 'warning.light', color: 'warning.dark' } }
  return { label: 'Expense', sx: { ...baseSx, bgcolor: 'error.light', color: 'error.dark' } }
}

const typeFilterOptions = [
  { value: 'ALL', label: 'All Types' },
  { value: 'RECEIPT', label: 'Receipt' },
  { value: 'OPENING', label: 'Opening' },
  { value: 'EXPENSE', label: 'Expense' },
  { value: 'WITHDRAWAL', label: 'Withdrawal' },
  { value: 'PAYMENT', label: 'Payment' },
  { value: 'CONTRA', label: 'Contra' },
  { value: 'RETURN', label: 'Refund' },
  { value: 'SPLIT', label: 'Split' },
]

function rowTypeForFilter(row: any) {
  if (row?.source === 'RETURN') return 'RETURN'
  if (row?.source === 'CONTRA' || row?.source === 'CASHBOOK_CONTRA') return 'CONTRA'
  return String(row?.pill_type || row?.entry_type || '').toUpperCase()
}

function matchesFilters(row: any, typeFilter: string, noteFilter: string) {
  const type = rowTypeForFilter(row)
  const entryType = String(row?.entry_type || '').toUpperCase()
  const typeOk = typeFilter === 'ALL' || type === typeFilter || entryType === typeFilter
  const needle = noteFilter.trim().toLowerCase()
  const subText = (row?.subRows || []).map((sub: any) => `bill #${sub.bill_id} ${sub.amount}`).join(' ')
  const noteOk = !needle || `${String(row?.note || '')} ${subText}`.toLowerCase().includes(needle)
  return typeOk && noteOk
}

function partyReceiptIdFromPayment(row: any): number | null {
  const match = /party\s+receipt\s+#(\d+)/i.exec(String(row?.note || '').trim())
  return match ? Number(match[1]) : null
}

function buildOnlineReceiptRows(payments: any[]) {
  const rows: any[] = []
  const grouped = new Map<number, any>()
  for (const p of payments || []) {
    const amount = Number(p?.online_amount || 0)
    if (amount <= 0) continue
    const receiptId = partyReceiptIdFromPayment(p)
    if (!receiptId) {
      rows.push({
        id: `pay-${p.id}`,
        created_at: p.received_at,
        entry_type: 'RECEIPT',
        pill_type: p.mode === 'split' ? 'SPLIT' : 'RECEIPT',
        amount,
        txn_charges: 0,
        mode: 'ONLINE',
        bill_id: Number(p.bill_id || 0),
        note: `Online payment for Bill #${p.bill_id}`,
        source: 'BILL' as const,
      })
      continue
    }
    const current = grouped.get(receiptId) || {
      id: `party-receipt-online-${receiptId}`,
      receipt_id: receiptId,
      created_at: p.received_at,
      entry_type: 'RECEIPT',
      pill_type: p.mode === 'split' ? 'SPLIT' : 'RECEIPT',
      amount: 0,
      txn_charges: 0,
      mode: 'ONLINE',
      note: `Online customer receipt #${receiptId}`,
      source: 'PARTY_RECEIPT' as const,
      subRows: [],
    }
    current.amount = Number(current.amount || 0) + amount
    if (p.mode === 'split') current.pill_type = 'SPLIT'
    current.subRows.push({ bill_id: Number(p.bill_id || 0), amount, payment_id: p.id })
    current.note = `Online customer receipt #${receiptId}: ${current.subRows.map((sub: any) => `Bill #${sub.bill_id}`).join(', ')}`
    grouped.set(receiptId, current)
  }
  for (const row of grouped.values()) {
    row.subRows.sort((a: any, b: any) => Number(a.bill_id || 0) - Number(b.bill_id || 0))
    rows.push(row)
  }
  return rows
}

function purchasePaymentNote(payment: any) {
  const invoice = payment?.invoice_number ? ` ${payment.invoice_number}` : ` #${payment?.purchase_id || ''}`
  const supplier = payment?.supplier_name ? ` - ${payment.supplier_name}` : ''
  const note = payment?.note ? ` (${payment.note})` : ''
  return `Online supplier payment for purchase${invoice}${supplier}${note}`
}

function buildPurchaseOnlineRows(payments: any[]) {
  return (payments || [])
    .filter((p) => Number(p?.online_amount || 0) > 0)
    .map((p) => ({
      id: `purchase-payment-online-${p.id}`,
      created_at: p.paid_at,
      entry_type: 'WITHDRAWAL',
      pill_type: p.mode === 'split' ? 'SPLIT' : 'PAYMENT',
      amount: Number(p.online_amount || 0),
      txn_charges: 0,
      mode: 'ONLINE',
      purchase_id: Number(p.purchase_id || 0),
      note: purchasePaymentNote(p),
      source: 'PURCHASE_PAYMENT' as const,
    }))
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function computeBillProration(bill: any) {
  const items = (bill?.items || []) as any[]
  const sub = items.reduce((s: number, it: any) => s + Number(it.mrp) * Number(it.quantity), 0)
  const discPct = Number(bill?.discount_percent || 0)
  const taxPct = Number(bill?.tax_percent || 0)
  const discAmt = (sub * discPct) / 100
  const afterDisc = sub - discAmt
  const taxAmt = (afterDisc * taxPct) / 100
  const computedTotal = afterDisc + taxAmt
  const finalTotal =
    bill?.total_amount !== undefined && bill?.total_amount !== null
      ? Number(bill.total_amount)
      : computedTotal
  const factor = computedTotal > 0 ? finalTotal / computedTotal : 1
  return { discPct, taxPct, factor }
}

function chargedLine(bill: any, mrp: number, qty: number) {
  const { discPct, taxPct, factor } = computeBillProration(bill)
  const lineSub = Number(mrp) * Number(qty)
  const afterDisc = lineSub * (1 - discPct / 100)
  const afterTax = afterDisc * (1 + taxPct / 100)
  return round2(afterTax * factor)
}

const manualModes: Array<{ value: BankbookMode; label: string }> = [
  { value: 'UPI', label: 'UPI' },
  { value: 'NEFT', label: 'NEFT' },
  { value: 'RTGS', label: 'RTGS' },
  { value: 'IMPS', label: 'IMPS' },
  { value: 'BANK_DEPOSIT', label: 'Bank Deposit (Contra)' },
]

function currentFinancialYearStart(ymd: string) {
  const [year, month] = ymd.split('-').map(Number)
  const startYear = (month || 1) >= 4 ? year : year - 1
  return `${startYear}-04-01`
}

function bankDepositDefaultNote(entryType: BankbookType) {
  if (entryType === 'CONTRA') return 'Contra entry: cash withdrawn from bank'
  if (entryType === 'RECEIPT') return 'Contra entry: cash deposited into bank'
  if (entryType === 'WITHDRAWAL') return 'Contra entry: cash withdrawn from bank'
  return 'Contra entry: bank adjustment'
}

const bankDepositDefaultNotes = [
  bankDepositDefaultNote('CONTRA'),
  bankDepositDefaultNote('RECEIPT'),
  bankDepositDefaultNote('WITHDRAWAL'),
  bankDepositDefaultNote('EXPENSE'),
]

export default function BankBookPage() {
  const qc = useQueryClient()
  const today = useMemo(() => toYMD(new Date()), [])
  const [selectedDate, setSelectedDate] = useState(today)
  const [recordsFilter, setRecordsFilter] = useState<'DAY' | 'ALL'>('DAY')
  const [allView, setAllView] = useState<'ALL' | 'WEEK' | 'MONTH' | 'CUSTOM'>('ALL')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [allAnchorDate, setAllAnchorDate] = useState(today)
  const [debouncedAllAnchorDate, setDebouncedAllAnchorDate] = useState(today)
  const [rangeFrom, setRangeFrom] = useState(today)
  const [rangeTo, setRangeTo] = useState(today)
  const [typeFilter, setTypeFilter] = useState('ALL')
  const [noteFilter, setNoteFilter] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const [entryType, setEntryType] = useState<BankbookType>('RECEIPT')
  const [entryMode, setEntryMode] = useState<BankbookMode>('UPI')
  const [entryDate, setEntryDate] = useState(today)
  const [amount, setAmount] = useState('')
  const [txnCharges, setTxnCharges] = useState('')
  const [note, setNote] = useState('')
  const [billOpen, setBillOpen] = useState(false)
  const [billLoading, setBillLoading] = useState(false)
  const [billDetail, setBillDetail] = useState<any | null>(null)
  const [billEditOpen, setBillEditOpen] = useState(false)
  const [editRow, setEditRow] = useState<any | null>(null)
  const [editType, setEditType] = useState<BankbookType>('RECEIPT')
  const [editMode, setEditMode] = useState<BankbookMode>('UPI')
  const [editDate, setEditDate] = useState(today)
  const [editAmount, setEditAmount] = useState('')
  const [editTxnCharges, setEditTxnCharges] = useState('')
  const [editNote, setEditNote] = useState('')
  const [deleteRow, setDeleteRow] = useState<any | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAllAnchorDate(allAnchorDate), 250)
    return () => clearTimeout(t)
  }, [allAnchorDate])

  useEffect(() => {
    if (recordsFilter === 'DAY') setEntryDate(selectedDate)
  }, [recordsFilter, selectedDate])

  const yearsQ = useQuery({
    queryKey: ['bankbook-financial-years'],
    queryFn: fetchFinancialYears,
  })
  const activeYear = useMemo(() => (yearsQ.data || []).find((year) => year.is_active) || null, [yearsQ.data])

  useEffect(() => {
    if (entryMode !== 'BANK_DEPOSIT' && entryType !== 'CONTRA') return
    const trimmed = note.trim()
    const nextDefault = bankDepositDefaultNote(entryType)
    if (!trimmed || bankDepositDefaultNotes.includes(trimmed)) {
      setNote(nextDefault)
    }
  }, [entryMode, entryType, note])

  useEffect(() => {
    if (entryType === 'OPENING') {
      setEntryMode('OPENING')
      setEntryDate(currentFinancialYearStart(today))
      if (!note.trim()) setNote('Opening balance as of 1 April')
      return
    }
    if (entryType === 'CONTRA') {
      setEntryMode('BANK_DEPOSIT')
      return
    }
    if (entryMode === 'OPENING') setEntryMode('UPI')
  }, [entryMode, entryType, note, today])

  const allRange = useMemo(() => {
    if (allView === 'WEEK') return weekRange(debouncedAllAnchorDate)
    if (allView === 'MONTH') return monthRange(debouncedAllAnchorDate)
    if (allView === 'CUSTOM') return { from: rangeFrom || undefined, to: rangeTo || undefined }
    return { from: activeYear?.start_date, to: activeYear?.end_date }
  }, [activeYear?.end_date, activeYear?.start_date, allView, debouncedAllAnchorDate, rangeFrom, rangeTo])
  const canLoadAllRange =
    recordsFilter === 'ALL' &&
    (allView === 'CUSTOM'
      ? Boolean(allRange.from && allRange.to && allRange.from <= allRange.to)
      : allView !== 'ALL' || Boolean(activeYear))

  const qDay = useQuery({
    queryKey: ['bankbook-day', selectedDate],
    queryFn: () => getBankbookDay({ date: selectedDate }),
    enabled: recordsFilter === 'DAY',
  })

  const qDayPayments = useQuery({
    queryKey: ['bankbook-payments-day', selectedDate],
    queryFn: () => listPayments({ from_date: selectedDate, to_date: selectedDate, limit: 500 }),
    enabled: recordsFilter === 'DAY',
  })

  const qDayPurchasePayments = useQuery({
    queryKey: ['bankbook-purchase-payments-day', selectedDate],
    queryFn: () => listPurchasePayments({ from_date: selectedDate, to_date: selectedDate, limit: 500 }),
    enabled: recordsFilter === 'DAY',
  })

  const qDayReturns = useQuery({
    queryKey: ['bankbook-returns-day', selectedDate],
    queryFn: () => listReturns({ from_date: selectedDate, to_date: selectedDate, limit: 500 }),
    enabled: recordsFilter === 'DAY',
  })

  const qDayExchanges = useQuery({
    queryKey: ['bankbook-exchanges-day', selectedDate],
    queryFn: () => listExchangeRecords({ from_date: selectedDate, to_date: selectedDate, limit: 500 }),
    enabled: recordsFilter === 'DAY',
  })

  const qDayCashbookContra = useQuery({
    queryKey: ['bankbook-cashbook-contra-day', selectedDate],
    queryFn: () => listCashbookEntries({ from_date: selectedDate, to_date: selectedDate, limit: 500 }),
    enabled: recordsFilter === 'DAY',
  })

  const qAllBankbook = useQuery({
    queryKey: ['bankbook-all-entries', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listBankbookEntries({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: canLoadAllRange,
  })

  const qAllPayments = useQuery({
    queryKey: ['bankbook-all-payments', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listPayments({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: canLoadAllRange,
  })

  const qAllPurchasePayments = useQuery({
    queryKey: ['bankbook-all-purchase-payments', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listPurchasePayments({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: canLoadAllRange,
  })

  const qAllReturns = useQuery({
    queryKey: ['bankbook-all-returns', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listReturns({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: canLoadAllRange,
  })

  const qAllExchanges = useQuery({
    queryKey: ['bankbook-all-exchanges', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listExchangeRecords({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: canLoadAllRange,
  })

  const qAllCashbookContra = useQuery({
    queryKey: ['bankbook-cashbook-contra-all', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listCashbookEntries({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: canLoadAllRange,
  })

  const mCreate = useMutation({
    mutationFn: () =>
      createBankbookEntry({
        entry_type: entryType,
        mode: entryType === 'CONTRA' ? 'BANK_DEPOSIT' : entryMode,
        amount: Number(amount),
        txn_charges: entryType === 'CONTRA' ? 0 : Number(txnCharges || 0),
        note: note.trim() || undefined,
        entry_date: entryDate,
      }),
    onSuccess: () => {
      setAmount('')
      setTxnCharges('')
      setNote('')
      setAddOpen(false)
      setEntryMode('UPI')
      setSelectedDate(entryDate)
      qc.invalidateQueries({ queryKey: ['bankbook-day'] })
      qc.invalidateQueries({ queryKey: ['bankbook-all-entries'] })
      qc.invalidateQueries({ queryKey: ['bankbook-daily-summary'] })
      qc.invalidateQueries({ queryKey: ['cashbook-day'] })
      qc.invalidateQueries({ queryKey: ['cashbook-all-entries'] })
      qc.invalidateQueries({ queryKey: ['cashbook-daily-summary'] })
      qc.invalidateQueries({ queryKey: ['cashbook-bankbook-contra-day'] })
      qc.invalidateQueries({ queryKey: ['cashbook-bankbook-contra-all'] })
      qc.invalidateQueries({ queryKey: ['bankbook-cashbook-contra-day'] })
      qc.invalidateQueries({ queryKey: ['bankbook-cashbook-contra-all'] })
    },
  })

  const mUpdate = useMutation({
    mutationFn: () =>
      updateBankbookEntry(Number(editRow?.id), {
        entry_type: editType,
        mode: editType === 'OPENING' ? 'OPENING' : editType === 'CONTRA' ? 'BANK_DEPOSIT' : editMode,
        amount: Number(editAmount),
        txn_charges: editType === 'CONTRA' ? 0 : Number(editTxnCharges || 0),
        note: editNote.trim() || undefined,
        entry_date: editDate,
      }),
    onSuccess: (updated: any) => {
      setEditRow(null)
      if (updated?.created_at) setSelectedDate(isoDate(updated.created_at))
      qc.invalidateQueries({ queryKey: ['bankbook-day'] })
      qc.invalidateQueries({ queryKey: ['bankbook-all-entries'] })
      qc.invalidateQueries({ queryKey: ['bankbook-daily-summary'] })
      qc.invalidateQueries({ queryKey: ['cashbook-day'] })
      qc.invalidateQueries({ queryKey: ['cashbook-all-entries'] })
      qc.invalidateQueries({ queryKey: ['cashbook-daily-summary'] })
      qc.invalidateQueries({ queryKey: ['cashbook-bankbook-contra-day'] })
      qc.invalidateQueries({ queryKey: ['cashbook-bankbook-contra-all'] })
      qc.invalidateQueries({ queryKey: ['bankbook-cashbook-contra-day'] })
      qc.invalidateQueries({ queryKey: ['bankbook-cashbook-contra-all'] })
    },
  })

  const mDelete = useMutation({
    mutationFn: (row: any) => deleteBankbookEntry(Number(row?.id)),
    onSuccess: (_deleted: any, row: any) => {
      const deletedDate = isoDate(row?.created_at)
      setDeleteRow(null)
      if (deletedDate !== '-') setSelectedDate(deletedDate)
      qc.invalidateQueries({ queryKey: ['bankbook-day'] })
      qc.invalidateQueries({ queryKey: ['bankbook-all-entries'] })
      qc.invalidateQueries({ queryKey: ['bankbook-daily-summary'] })
      qc.invalidateQueries({ queryKey: ['cashbook-day'] })
      qc.invalidateQueries({ queryKey: ['cashbook-all-entries'] })
      qc.invalidateQueries({ queryKey: ['cashbook-daily-summary'] })
      qc.invalidateQueries({ queryKey: ['cashbook-bankbook-contra-day'] })
      qc.invalidateQueries({ queryKey: ['cashbook-bankbook-contra-all'] })
      qc.invalidateQueries({ queryKey: ['bankbook-cashbook-contra-day'] })
      qc.invalidateQueries({ queryKey: ['bankbook-cashbook-contra-all'] })
    },
  })

  const day = qDay.data
  const canGoNext = selectedDate < today
  const canSave = Number(amount) > 0 && !!entryDate && !mCreate.isPending
  const canGoAllNext = allAnchorDate < today

  async function openBillDetail(billId: number) {
    if (!Number.isFinite(Number(billId)) || Number(billId) <= 0) return
    setBillOpen(true)
    setBillLoading(true)
    setBillDetail(null)
    try {
      const b = await getBill(Number(billId))
      setBillDetail(b)
    } catch {
      setBillDetail(null)
    } finally {
      setBillLoading(false)
    }
  }

  function openEdit(row: any) {
    const type = String(row.entry_type || 'RECEIPT').toUpperCase() as BankbookType
    setEditRow(row)
    setEditType(type)
    setEditMode(type === 'OPENING' ? 'OPENING' : (String(row.mode || 'UPI').toUpperCase() as BankbookMode))
    setEditDate(isoDate(row.created_at) === '-' ? today : isoDate(row.created_at))
    setEditAmount(String(Number(row.amount || 0)))
    setEditTxnCharges(String(Number(row.txn_charges || 0)))
    setEditNote(String(row.note || ''))
  }

  const billOnlineRowsDay = useMemo(() => {
    const payments = (qDayPayments.data || []) as any[]
    return buildOnlineReceiptRows(payments)
  }, [qDayPayments.data])

  const billOnlineRowsAll = useMemo(() => {
    const payments = (qAllPayments.data || []) as any[]
    return buildOnlineReceiptRows(payments)
  }, [qAllPayments.data])

  const purchaseOnlineRowsDay = useMemo(() => {
    const payments = (qDayPurchasePayments.data || []) as any[]
    return buildPurchaseOnlineRows(payments)
  }, [qDayPurchasePayments.data])

  const purchaseOnlineRowsAll = useMemo(() => {
    const payments = (qAllPurchasePayments.data || []) as any[]
    return buildPurchaseOnlineRows(payments)
  }, [qAllPurchasePayments.data])

  const returnOnlineRowsDay = useMemo(() => {
    const returns = (qDayReturns.data || []) as any[]
    const exchangeByReturnId = new Map<number, any>()
    for (const ex of (qDayExchanges.data || []) as any[]) exchangeByReturnId.set(Number(ex.return_id), ex)
    return returns
      .filter((r) => Number(r?.refund_online || 0) > 0)
      .map((r) => ({
        id: `return-${r.id}`,
        created_at: r.date_time,
        entry_type: 'WITHDRAWAL',
        pill_type: exchangeByReturnId.has(Number(r.id)) ? 'RETURN' : undefined,
        amount: Number(r.refund_online || 0),
        txn_charges: 0,
        mode: 'ONLINE',
        note: exchangeByReturnId.has(Number(r.id))
          ? `Online refund in exchange #${exchangeByReturnId.get(Number(r.id))?.id ?? ''}`
          : `Online return #${r.id}`,
        source: 'RETURN' as const,
      }))
  }, [qDayReturns.data, qDayExchanges.data])

  const returnOnlineRowsAll = useMemo(() => {
    const returns = (qAllReturns.data || []) as any[]
    const exchangeByReturnId = new Map<number, any>()
    for (const ex of (qAllExchanges.data || []) as any[]) exchangeByReturnId.set(Number(ex.return_id), ex)
    return returns
      .filter((r) => Number(r?.refund_online || 0) > 0)
      .map((r) => ({
        id: `return-${r.id}`,
        created_at: r.date_time,
        entry_type: 'WITHDRAWAL',
        pill_type: exchangeByReturnId.has(Number(r.id)) ? 'RETURN' : undefined,
        amount: Number(r.refund_online || 0),
        txn_charges: 0,
        mode: 'ONLINE',
        note: exchangeByReturnId.has(Number(r.id))
          ? `Online refund in exchange #${exchangeByReturnId.get(Number(r.id))?.id ?? ''}`
          : `Online return #${r.id}`,
        source: 'RETURN' as const,
      }))
  }, [qAllReturns.data, qAllExchanges.data])

  const exchangeOnlineInRowsDay = useMemo(() => {
    const exchanges = (qDayExchanges.data || []) as any[]
    return exchanges
      .filter((x) => Number(x?.payment_online || 0) > 0)
      .map((x) => ({
        id: `exchange-in-${x.id}`,
        created_at: x.created_at,
        entry_type: 'RECEIPT',
        amount: Number(x.payment_online || 0),
        txn_charges: 0,
        mode: 'ONLINE',
        note: `Online received in exchange #${x.id}`,
        source: 'EXCHANGE' as const,
      }))
  }, [qDayExchanges.data])

  const exchangeOnlineInRowsAll = useMemo(() => {
    const exchanges = (qAllExchanges.data || []) as any[]
    return exchanges
      .filter((x) => Number(x?.payment_online || 0) > 0)
      .map((x) => ({
        id: `exchange-in-${x.id}`,
        created_at: x.created_at,
        entry_type: 'RECEIPT',
        amount: Number(x.payment_online || 0),
        txn_charges: 0,
        mode: 'ONLINE',
        note: `Online received in exchange #${x.id}`,
        source: 'EXCHANGE' as const,
      }))
  }, [qAllExchanges.data])

  const exchangeOnlineOutRowsDay = useMemo(() => {
    const exchanges = (qDayExchanges.data || []) as any[]
    return exchanges
      .filter((x) => Number(x?.refund_online || 0) > 0)
      .map((x) => ({
        id: `exchange-out-${x.id}`,
        created_at: x.created_at,
        entry_type: 'WITHDRAWAL',
        amount: Number(x.refund_online || 0),
        txn_charges: 0,
        mode: 'ONLINE',
        note: `Online refunded in exchange #${x.id}`,
        source: 'EXCHANGE' as const,
      }))
  }, [qDayExchanges.data])

  const exchangeOnlineOutRowsAll = useMemo(() => {
    const exchanges = (qAllExchanges.data || []) as any[]
    return exchanges
      .filter((x) => Number(x?.refund_online || 0) > 0)
      .map((x) => ({
        id: `exchange-out-${x.id}`,
        created_at: x.created_at,
        entry_type: 'WITHDRAWAL',
        amount: Number(x.refund_online || 0),
        txn_charges: 0,
        mode: 'ONLINE',
        note: `Online refunded in exchange #${x.id}`,
        source: 'EXCHANGE' as const,
      }))
  }, [qAllExchanges.data])

  const cashbookContraRowsDay = useMemo(() => {
    const rows = (qDayCashbookContra.data || []) as any[]
    return rows
      .filter((r) => String(r?.entry_type || '').toUpperCase() === 'CONTRA' && Number(r?.amount || 0) > 0)
      .map((r) => ({
        id: `cashbook-contra-${r.id}`,
        created_at: r.created_at,
        entry_type: 'RECEIPT',
        pill_type: 'CONTRA',
        amount: Number(r.amount || 0),
        txn_charges: 0,
        mode: 'BANK_DEPOSIT',
        note: r.note ? `Cashbook contra: ${r.note}` : 'Cashbook contra deposit',
        source: 'CASHBOOK_CONTRA' as const,
      }))
  }, [qDayCashbookContra.data])

  const cashbookContraRowsAll = useMemo(() => {
    const rows = (qAllCashbookContra.data || []) as any[]
    return rows
      .filter((r) => String(r?.entry_type || '').toUpperCase() === 'CONTRA' && Number(r?.amount || 0) > 0)
      .map((r) => ({
        id: `cashbook-contra-${r.id}`,
        created_at: r.created_at,
        entry_type: 'RECEIPT',
        pill_type: 'CONTRA',
        amount: Number(r.amount || 0),
        txn_charges: 0,
        mode: 'BANK_DEPOSIT',
        note: r.note ? `Cashbook contra: ${r.note}` : 'Cashbook contra deposit',
        source: 'CASHBOOK_CONTRA' as const,
      }))
  }, [qAllCashbookContra.data])

  const manualRowsDay = useMemo(() => {
    const rows = (day?.entries || []) as any[]
    return rows
      .filter((r) => String(r?.entry_type || '').toUpperCase() !== 'OPENING')
      .map((r) => ({ ...r, source: 'BANKBOOK' as const }))
  }, [day?.entries])

  const manualRowsAll = useMemo(() => {
    const rows = (qAllBankbook.data || []) as any[]
    return rows.map((r) => ({ ...r, source: 'BANKBOOK' as const }))
  }, [qAllBankbook.data])

  const manualChargeRowsDay = useMemo(() => {
    return manualRowsDay
      .filter((r) => Number(r?.txn_charges || 0) > 0)
      .map((r) => ({
        id: `charge-${r.id}`,
        created_at: r.created_at,
        entry_type: 'EXPENSE',
        pill_type: 'EXPENSE',
        amount: Number(r.txn_charges || 0),
        txn_charges: 0,
        mode: r.mode,
        linked_entry_id: r.id,
        note: `Bank charges linked to entry #${r.id}${r.note ? ` • ${r.note}` : ''}`,
        source: 'BANKBOOK_CHARGE' as const,
        sort_order: 1,
      }))
  }, [manualRowsDay])

  const manualChargeRowsAll = useMemo(() => {
    return manualRowsAll
      .filter((r) => Number(r?.txn_charges || 0) > 0)
      .map((r) => ({
        id: `charge-${r.id}`,
        created_at: r.created_at,
        entry_type: 'EXPENSE',
        pill_type: 'EXPENSE',
        amount: Number(r.txn_charges || 0),
        txn_charges: 0,
        mode: r.mode,
        linked_entry_id: r.id,
        note: `Bank charges linked to entry #${r.id}${r.note ? ` • ${r.note}` : ''}`,
        source: 'BANKBOOK_CHARGE' as const,
        sort_order: 1,
      }))
  }, [manualRowsAll])

  const ledgerRows = useMemo(() => {
    const rows =
      recordsFilter === 'DAY'
        ? [
            {
              id: `opening-${selectedDate}`,
              created_at: `${selectedDate}T00:00:00`,
              entry_type: 'OPENING',
              amount: Number(day?.opening_balance || 0),
              txn_charges: 0,
              mode: '-',
              note: 'Opening Balance',
              source: 'SYSTEM' as const,
              sort_order: -1,
            },
            ...manualRowsDay,
            ...manualChargeRowsDay,
            ...billOnlineRowsDay,
            ...purchaseOnlineRowsDay,
            ...cashbookContraRowsDay,
            ...exchangeOnlineInRowsDay,
            ...exchangeOnlineOutRowsDay,
            ...returnOnlineRowsDay,
          ]
        : [
            ...manualRowsAll,
            ...manualChargeRowsAll,
            ...billOnlineRowsAll,
            ...purchaseOnlineRowsAll,
            ...cashbookContraRowsAll,
            ...exchangeOnlineInRowsAll,
            ...exchangeOnlineOutRowsAll,
            ...returnOnlineRowsAll,
          ]
    return rows.sort((a: any, b: any) => {
      const byTime = String(a.created_at || '').localeCompare(String(b.created_at || ''))
      if (byTime !== 0) return sortDir === 'asc' ? byTime : -byTime
      const byOrder = Number(a.sort_order || 0) - Number(b.sort_order || 0)
      return sortDir === 'asc' ? byOrder : -byOrder
    })
  }, [
    recordsFilter,
    sortDir,
    selectedDate,
    day?.opening_balance,
    manualRowsDay,
    manualChargeRowsDay,
    billOnlineRowsDay,
    purchaseOnlineRowsDay,
    cashbookContraRowsDay,
    exchangeOnlineInRowsDay,
    exchangeOnlineOutRowsDay,
    returnOnlineRowsDay,
    manualRowsAll,
    manualChargeRowsAll,
    billOnlineRowsAll,
    purchaseOnlineRowsAll,
    cashbookContraRowsAll,
    exchangeOnlineInRowsAll,
    exchangeOnlineOutRowsAll,
    returnOnlineRowsAll,
  ])

  const allLedgerDates = useMemo(() => {
    if (recordsFilter !== 'ALL') return []
    return Array.from(new Set((ledgerRows || []).map((row: any) => isoDate(row.created_at)).filter((date) => date !== '-'))).sort()
  }, [ledgerRows, recordsFilter])

  const qDailySummary = useQuery({
    queryKey: ['bankbook-daily-summary', allLedgerDates.join(',')],
    queryFn: () => getBankbookDailySummary({ dates: allLedgerDates }),
    enabled: recordsFilter === 'ALL' && allLedgerDates.length > 0,
  })

  const dailySummaryByDate = useMemo(() => {
    const out: Record<string, any> = {}
    for (const row of qDailySummary.data || []) out[String(row.date)] = row
    return out
  }, [qDailySummary.data])

  const visibleRows = useMemo(
    () => ledgerRows.filter((row: any) => matchesFilters(row, typeFilter, noteFilter)),
    [ledgerRows, noteFilter, typeFilter],
  )

  const hasActiveFilters = typeFilter !== 'ALL' || noteFilter.trim().length > 0

  const dayColorMap = useMemo(() => {
    if (recordsFilter !== 'ALL') return {} as Record<string, string>
    const palette = ['#f6fbff', '#eef6ff']
    const dates = Array.from(new Set((visibleRows || []).map((r: any) => isoDate(r.created_at))))
    const out: Record<string, string> = {}
    dates.forEach((d, i) => {
      out[d] = palette[i % palette.length]
    })
    return out
  }, [recordsFilter, visibleRows])

  const computed = useMemo(() => {
    let receipts = 0
    let withdrawals = 0
    let expenses = 0
    let charges = 0
    for (const r of visibleRows as any[]) {
      const t = String(r.entry_type || '').toUpperCase()
      const amt = Number(r.amount || 0)
      if (t === 'OPENING') continue
      if (t === 'RECEIPT') receipts += amt
      else if (t === 'WITHDRAWAL' || t === 'CONTRA') withdrawals += amt
      else expenses += amt
      if (r.source === 'BANKBOOK_CHARGE') charges += amt
    }
    const bankOut = withdrawals + expenses
    const netChange = receipts - bankOut
    return { receipts, withdrawals, expenses, charges, bankOut, netChange }
  }, [visibleRows])

  const totalsBottom = useMemo(() => {
    const opening = recordsFilter === 'DAY' ? Number(day?.opening_balance || 0) : 0
    const closing =
      recordsFilter === 'DAY' ? Number(day?.closing_balance ?? opening + computed.netChange) : opening + computed.netChange
    return { opening, closing }
  }, [recordsFilter, day?.opening_balance, day?.closing_balance, computed.netChange])

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Bank Book
          </Typography>
          <TextField
            select
            size="small"
            label="Records"
            value={recordsFilter}
            onChange={(e) => setRecordsFilter(e.target.value as 'DAY' | 'ALL')}
            sx={{ minWidth: 150, ml: { sm: 'auto' } }}
          >
            <MenuItem value="DAY">Selected Day</MenuItem>
            <MenuItem value="ALL">Current FY Records</MenuItem>
          </TextField>
          {recordsFilter === 'DAY' ? (
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ ml: { sm: 'auto' } }}>
              <TextField
                size="small"
                label="Date"
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                sx={{ minWidth: 170 }}
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button variant="outlined" onClick={() => setSelectedDate(addDays(selectedDate, -1))}>
                  Previous Day
                </Button>
                <Button variant="outlined" onClick={() => setSelectedDate(today)} disabled={selectedDate === today}>
                  Today
                </Button>
                <Button variant="outlined" onClick={() => setSelectedDate(addDays(selectedDate, 1))} disabled={!canGoNext}>
                  Next Day
                </Button>
              </Stack>
            </Stack>
          ) : null}
        </Stack>
        {recordsFilter === 'DAY' ? (
          <Stack sx={{ mt: 1 }} spacing={0.25}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              Date: {selectedDate}
            </Typography>
            <Typography variant="body2" sx={{ color: 'error.main' }}>
              Note: user-entered opening balance is treated as the actual opening. If none is set, it is carried from previous day closing.
            </Typography>
          </Stack>
        ) : (
          <Stack sx={{ mt: 1 }} spacing={1}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ width: '100%' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setAllView('ALL')}
                  sx={allView === 'ALL' ? { bgcolor: '#e9f2ff', borderColor: '#8bb5f8' } : undefined}
                >
                  Current FY
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setAllView('WEEK')}
                  sx={allView === 'WEEK' ? { bgcolor: '#e9f2ff', borderColor: '#8bb5f8' } : undefined}
                >
                  Week
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setAllView('MONTH')}
                  sx={allView === 'MONTH' ? { bgcolor: '#e9f2ff', borderColor: '#8bb5f8' } : undefined}
                >
                  Month
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setAllView('CUSTOM')}
                  sx={allView === 'CUSTOM' ? { bgcolor: '#e9f2ff', borderColor: '#8bb5f8' } : undefined}
                >
                  Custom
                </Button>
              </Stack>
              {allView === 'CUSTOM' ? (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ ml: { sm: 'auto' }, justifyContent: { sm: 'flex-end' } }}>
                  <TextField
                    size="small"
                    label="From"
                    type="date"
                    value={rangeFrom}
                    onChange={(e) => setRangeFrom(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    sx={{ minWidth: 160 }}
                  />
                  <TextField
                    size="small"
                    label="To"
                    type="date"
                    value={rangeTo}
                    onChange={(e) => setRangeTo(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    sx={{ minWidth: 160 }}
                  />
                  <Button variant="outlined" size="small" onClick={() => { setRangeFrom(today); setRangeTo(today) }}>
                    Today
                  </Button>
                </Stack>
              ) : allView !== 'ALL' ? (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ ml: { sm: 'auto' }, justifyContent: { sm: 'flex-end' } }}>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => setAllAnchorDate(allView === 'WEEK' ? addDays(allAnchorDate, -7) : addMonths(allAnchorDate, -1))}
                  >
                    Previous {allView === 'WEEK' ? 'Week' : 'Month'}
                  </Button>
                  <Button variant="outlined" size="small" onClick={() => setAllAnchorDate(today)} disabled={allAnchorDate === today}>
                    Today
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => setAllAnchorDate(allView === 'WEEK' ? addDays(allAnchorDate, 7) : addMonths(allAnchorDate, 1))}
                    disabled={!canGoAllNext}
                  >
                    Next {allView === 'WEEK' ? 'Week' : 'Month'}
                  </Button>
                </Stack>
              ) : null}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {allView === 'ALL'
                ? `Showing current financial year${activeYear ? `: ${financialYearDisplayName(activeYear)} (${activeYear.start_date} to ${activeYear.end_date})` : '.'}`
                : allView === 'CUSTOM' && !canLoadAllRange
                  ? 'Choose a valid custom date range.'
                : allView === 'CUSTOM'
                  ? `Showing custom range: ${allRange.from} to ${allRange.to}`
                : `Showing ${allView.toLowerCase()} view: ${allRange.from} to ${allRange.to}`}
            </Typography>
          </Stack>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap">
          {recordsFilter === 'DAY' ? <Chip label={`Opening: Rs ${money(day?.opening_balance)}`} /> : null}
          <Chip color="success" variant="outlined" label={`Receipts: Rs ${money(computed.receipts)}`} />
          <Chip color="error" variant="outlined" label={`Expenses: Rs ${money(computed.expenses)}`} />
          <Chip color="warning" variant="outlined" label={`Withdrawals: Rs ${money(computed.withdrawals)}`} />
          <Chip color="secondary" variant="outlined" label={`Charges: Rs ${money(computed.charges)}`} />
          {recordsFilter === 'DAY' ? (
            <Chip
              color="primary"
              label={`Closing: Rs ${money(Number(day?.closing_balance ?? Number(day?.opening_balance || 0) + computed.netChange))}`}
              sx={{ fontWeight: 700 }}
            />
          ) : (
            <Chip color="primary" label={`Net: Rs ${money(computed.netChange)}`} sx={{ fontWeight: 700 }} />
          )}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Add Bank Record
          </Typography>
          <Button
            variant="outlined"
            size="small"
            startIcon={addOpen ? <ExpandLessIcon /> : <AddIcon />}
            onClick={() => setAddOpen((open) => !open)}
            sx={{ ml: { sm: 'auto' }, alignSelf: { xs: 'flex-start', sm: 'center' } }}
          >
            {addOpen ? 'Collapse' : 'Add New Entry'}
          </Button>
        </Stack>
        <Collapse in={addOpen} timeout="auto" unmountOnExit>
          <Stack spacing={1.5} sx={{ mt: 1.5 }}>
            <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} flexWrap="wrap">
              <TextField
                select
                label="Entry Type"
                value={entryType}
                onChange={(e) => setEntryType(e.target.value as BankbookType)}
                sx={{ minWidth: 180 }}
              >
                <MenuItem value="OPENING">Opening Balance (1 Apr)</MenuItem>
                <MenuItem value="CONTRA">Contra (Bank to Cash)</MenuItem>
                <MenuItem value="RECEIPT">Receipt (Bank In)</MenuItem>
                <MenuItem value="EXPENSE">Expense (Bank Out)</MenuItem>
                <MenuItem value="WITHDRAWAL">Withdrawal (Bank Out)</MenuItem>
              </TextField>
              {entryType !== 'OPENING' && entryType !== 'CONTRA' ? (
                <TextField
                  select
                  label="Mode"
                  value={entryMode}
                  onChange={(e) => setEntryMode(e.target.value as BankbookMode)}
                  sx={{ minWidth: 220 }}
                >
                  {manualModes.map((mode) => (
                    <MenuItem key={mode.value} value={mode.value}>
                      {mode.label}
                    </MenuItem>
                  ))}
                </TextField>
              ) : null}
              <TextField
                label="Entry Date"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                sx={{ minWidth: 170 }}
              />
              <TextField
                label="Amount"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputProps={{ min: 0, step: '0.01' }}
                sx={{ minWidth: 140 }}
              />
              <TextField
                label="Txn Charges"
                type="number"
                value={txnCharges}
                onChange={(e) => setTxnCharges(e.target.value)}
                inputProps={{ min: 0, step: '0.01' }}
                sx={{ minWidth: 150 }}
                disabled={entryType === 'CONTRA'}
                helperText="Adds a separate linked charges entry"
              />
            </Stack>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'flex-start' }}>
              <TextField
                label="Note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={entryMode === 'BANK_DEPOSIT' ? bankDepositDefaultNote(entryType) : 'Optional details'}
                helperText={
                  entryMode === 'BANK_DEPOSIT'
                    ? 'Prefilled contra note. You can edit it before saving.'
                    : 'Optional details for the bank entry.'
                }
                multiline
                minRows={2}
                fullWidth
              />
              <Button
                variant="contained"
                onClick={() => mCreate.mutate()}
                disabled={!canSave}
                sx={{ minWidth: 140, mt: { md: 0.5 } }}
              >
                {mCreate.isPending ? 'Saving...' : 'Save Record'}
              </Button>
            </Stack>
          </Stack>
          {mCreate.isError ? (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              Failed to save bank record. Please try again.
            </Alert>
          ) : null}
        </Collapse>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mb: 1.5 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {recordsFilter === 'DAY' ? 'Day Entries' : 'All Records'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ ml: { sm: 'auto' } }}>
            {visibleRows.length} of {ledgerRows.length}
          </Typography>
        </Stack>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: '180px minmax(0, 1fr)',
              md: '180px minmax(260px, 1fr) auto auto',
            },
            gap: 1,
            alignItems: 'stretch',
            mb: 1.5,
          }}
        >
          <TextField
            select
            size="small"
            label="Type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            fullWidth
          >
            {typeFilterOptions.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Note filter"
            value={noteFilter}
            onChange={(e) => setNoteFilter(e.target.value)}
            placeholder="Search notes"
            fullWidth
          />
          {hasActiveFilters ? (
            <Button
              variant="outlined"
              size="small"
              onClick={() => {
                setTypeFilter('ALL')
                setNoteFilter('')
              }}
            >
              Clear Filters
            </Button>
          ) : null}
          <Stack direction="row" spacing={1}>
            <Button size="small" variant={sortDir === 'asc' ? 'contained' : 'outlined'} onClick={() => setSortDir('asc')}>
              Date Asc
            </Button>
            <Button size="small" variant={sortDir === 'desc' ? 'contained' : 'outlined'} onClick={() => setSortDir('desc')}>
              Date Desc
            </Button>
          </Stack>
        </Box>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Date</TableCell>
                <TableCell>Time</TableCell>
                <TableCell>Mode</TableCell>
                <TableCell>Note</TableCell>
                <TableCell align="right">Amount</TableCell>
                <TableCell align="right">Charges</TableCell>
                <TableCell>Source</TableCell>
                <TableCell align="right">Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(recordsFilter === 'DAY'
                ? qDay.isLoading ||
                  qDayPayments.isLoading ||
                  qDayPurchasePayments.isLoading ||
                  qDayReturns.isLoading ||
                  qDayExchanges.isLoading ||
                  qDayCashbookContra.isLoading
                : qAllBankbook.isLoading ||
                  qAllPayments.isLoading ||
                  qAllPurchasePayments.isLoading ||
                  qAllReturns.isLoading ||
                  qAllExchanges.isLoading ||
                  qAllCashbookContra.isLoading ||
                  qDailySummary.isLoading) ? (
                <TableRow>
                  <TableCell colSpan={8}>Loading...</TableCell>
                </TableRow>
              ) : visibleRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    {hasActiveFilters
                      ? 'No entries match the filters.'
                      : recordsFilter === 'DAY'
                        ? 'No entries for this day.'
                        : 'No records found.'}
                  </TableCell>
                </TableRow>
              ) : (
                (visibleRows || []).map((row: any, idx: number) => {
                  const t = String(row.entry_type || '').toUpperCase()
                  const chipType = row.source === 'RETURN' ? 'RETURN' : String(row.pill_type || t).toUpperCase()
                  const isIn = t === 'RECEIPT'
                  const chip = typeChipProps(chipType)
                  const date = isoDate(row.created_at)
                  const prevDate = idx > 0 ? isoDate((visibleRows as any[])[idx - 1]?.created_at) : date
                  const isNewDay = recordsFilter === 'ALL' && idx > 0 && date !== prevDate
                  const showDayHeader = recordsFilter === 'ALL' && (idx === 0 || isNewDay)
                  const daySummary = dailySummaryByDate[date]
                  return (
                    <Fragment key={row.id}>
                      {showDayHeader ? (
                        <TableRow>
                          <TableCell colSpan={8} sx={{ bgcolor: '#edf4f1', borderTop: idx > 0 ? '2px solid rgba(0,0,0,0.65)' : undefined }}>
                            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
                              <Typography variant="body2" sx={{ fontWeight: 800, minWidth: 120 }}>
                                {date}
                              </Typography>
                              {daySummary ? (
                                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap">
                                  <Chip size="small" label={`Opening: Rs ${money(daySummary.opening_balance)}`} />
                                  <Chip
                                    size="small"
                                    color={Number(daySummary.summary?.net_change || 0) >= 0 ? 'success' : 'error'}
                                    variant="outlined"
                                    label={`Net: Rs ${money(daySummary.summary?.net_change)}`}
                                  />
                                  <Chip size="small" color="primary" label={`Closing: Rs ${money(daySummary.closing_balance)}`} />
                                </Stack>
                              ) : (
                                <Typography variant="body2" color="text.secondary">
                                  Loading day totals...
                                </Typography>
                              )}
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ) : null}
                      <TableRow
                        hover
                        sx={
                          recordsFilter === 'ALL'
                            ? {
                                bgcolor: dayColorMap[date],
                              }
                            : undefined
                        }
                      >
                        <TableCell>{isoDate(row.created_at)}</TableCell>
                        <TableCell>{isoTime(row.created_at)}</TableCell>
                        <TableCell>
                          {row.source === 'BANKBOOK_CHARGE'
                            ? `${row.mode === 'BANK_DEPOSIT' ? 'Bank Deposit' : row.mode || '-'} Charge`
                            : row.mode === 'BANK_DEPOSIT'
                              ? 'Bank Deposit'
                              : row.mode || '-'}
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                            <Chip size="small" label={chip.label} sx={{ borderRadius: 999, ...chip.sx }} />
                            {row.source === 'BILL' && Number(row.bill_id || 0) > 0 ? (
                              <Typography variant="body2">
                                Online payment for{' '}
                                <Link component="button" onClick={() => openBillDetail(Number(row.bill_id))} underline="hover">
                                  Bill #{row.bill_id}
                                </Link>
                              </Typography>
                            ) : row.source === 'PARTY_RECEIPT' ? (
                              <Stack gap={0.25}>
                                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                  Customer receipt #{row.receipt_id}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {(row.subRows || []).length} bill adjustment(s)
                                </Typography>
                              </Stack>
                            ) : (
                              <Typography variant="body2">{row.note || '-'}</Typography>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell
                          align="right"
                          sx={{
                            color: t === 'OPENING' ? 'text.primary' : isIn ? 'success.main' : 'error.main',
                            fontWeight: 700,
                          }}
                        >
                          {t === 'OPENING' ? '' : isIn ? '+' : '-'}Rs {money(row.amount)}
                        </TableCell>
                        <TableCell align="right" sx={{ color: Number(row.txn_charges || 0) > 0 ? 'error.main' : 'text.secondary', fontWeight: 700 }}>
                          {Number(row.txn_charges || 0) > 0 ? `-Rs ${money(row.txn_charges)}` : '-'}
                        </TableCell>
                        <TableCell>
                          {row.source === 'BILL'
                            ? 'Bill'
                            : row.source === 'PARTY_RECEIPT'
                              ? 'Customer receipt'
                              : row.source === 'PURCHASE_PAYMENT'
                                ? 'Purchase'
                            : row.source === 'RETURN'
                              ? 'Return'
                              : row.source === 'EXCHANGE'
                                ? 'Exchange'
                                : row.source === 'CASHBOOK_CONTRA'
                                  ? 'Cashbook Contra'
                                  : row.source === 'BANKBOOK_CHARGE'
                                    ? 'Charges'
                                    : row.source === 'SYSTEM'
                                      ? 'System'
                                      : 'Bankbook'}
                        </TableCell>
                        <TableCell align="right">
                          {row.source === 'BANKBOOK' ? (
                            <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                              <Tooltip title="Edit entry">
                                <span>
                                  <IconButton size="small" onClick={() => openEdit(row)} disabled={mUpdate.isPending || mDelete.isPending}>
                                    <EditIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                              <Tooltip title="Delete entry">
                                <span>
                                  <IconButton
                                    size="small"
                                    color="error"
                                    onClick={() => {
                                      mDelete.reset()
                                      setDeleteRow(row)
                                    }}
                                    disabled={mUpdate.isPending || mDelete.isPending}
                                  >
                                    <DeleteIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            </Stack>
                          ) : (
                            '-'
                          )}
                        </TableCell>
                      </TableRow>
                      {(row.subRows || []).map((sub: any) => (
                        <TableRow key={`${row.id}-sub-${sub.payment_id || sub.bill_id}`} sx={{ bgcolor: recordsFilter === 'ALL' ? dayColorMap[date] : '#fafafa' }}>
                          <TableCell />
                          <TableCell />
                          <TableCell />
                          <TableCell>
                            <Stack direction="row" spacing={1} alignItems="center" sx={{ pl: 5 }}>
                              <Typography variant="caption" color="text.secondary">Applied to</Typography>
                              <Link component="button" onClick={() => openBillDetail(Number(sub.bill_id))} underline="hover" sx={{ fontSize: 13, fontWeight: 800 }}>
                                Bill #{sub.bill_id}
                              </Link>
                            </Stack>
                          </TableCell>
                          <TableCell align="right" sx={{ color: 'success.main', fontWeight: 700 }}>
                            +Rs {money(sub.amount)}
                          </TableCell>
                          <TableCell align="right">-</TableCell>
                          <TableCell>Receipt bill</TableCell>
                          <TableCell />
                        </TableRow>
                      ))}
                    </Fragment>
                  )
                })
              )}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4}>
                  <b>Totals</b>
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>
                  +Rs {money(computed.receipts)} / -Rs {money(computed.bankOut)}
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>
                  -Rs {money(computed.charges)}
                </TableCell>
                <TableCell colSpan={2} sx={{ fontWeight: 700 }}>
                  Net: Rs {money(computed.netChange)}
                </TableCell>
              </TableRow>
              {recordsFilter === 'DAY' ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <b>Opening / Closing</b>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>
                    Rs {money(totalsBottom.opening)} / Rs {money(totalsBottom.closing)}
                  </TableCell>
                  <TableCell colSpan={3} />
                </TableRow>
              ) : null}
            </TableFooter>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={billOpen} onClose={() => setBillOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Bill Details {billDetail?.id ? `#${billDetail.id}` : ''}
          <IconButton onClick={() => setBillOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {billLoading ? (
            <Typography color="text.secondary">Loading…</Typography>
          ) : !billDetail ? (
            <Typography color="error">Failed to load bill details.</Typography>
          ) : (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1">
                  ID: <b>{billDetail.id}</b>
                </Typography>
                <Typography variant="subtitle1">
                  Date/Time: <b>{billDetail.date_time || billDetail.created_at || '-'}</b>
                </Typography>
              </Stack>

              <Divider />

              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 220 }}>Item</th>
                      <th>Qty</th>
                      <th>MRP</th>
                      <th>Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(billDetail.items || []).map((it: any, idx: number) => {
                      const name = it.item_name || it.name || it.item?.name || `#${it.item_id}`
                      const qty = Number(it.quantity)
                      const mrp = Number(it.mrp)
                      return (
                        <tr key={idx}>
                          <td>{name}</td>
                          <td>{qty}</td>
                          <td>{money(mrp)}</td>
                          <td>{money(chargedLine(billDetail, mrp, qty))}</td>
                        </tr>
                      )
                    })}

                    {(billDetail.items || []).length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <Box p={2} color="text.secondary">
                            No items.
                          </Box>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Box>

              <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 420 }}>
                <Typography>
                  Total: <b>{money(billDetail.total_amount || 0)}</b>
                </Typography>
                <Typography>
                  Payment Mode: <b>{billDetail.payment_mode || '-'}</b>
                </Typography>
                <Typography>
                  Payment Status: <b>{billDetail.payment_status || (billDetail.is_credit ? 'UNPAID' : 'PAID')}</b>
                </Typography>
                <Typography>
                  Paid Amount: <b>{money(billDetail.paid_amount || 0)}</b>
                </Typography>
                <Typography>
                  Pending Amount:{' '}
                  <b>{money(Math.max(0, Number(billDetail.total_amount || 0) - Number(billDetail.paid_amount || 0) - Number(billDetail.writeoff_amount || 0)))}</b>
                </Typography>
                {billDetail.notes ? (
                  <Typography sx={{ mt: 1 }}>
                    Notes: <i>{billDetail.notes}</i>
                  </Typography>
                ) : null}
                <Box sx={{ pt: 1 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<EditIcon />}
                    onClick={() => setBillEditOpen(true)}
                  >
                    Edit Bill
                  </Button>
                </Box>
              </Stack>

              <Divider />
              <BillPaymentsPanel
                bill={billDetail}
                onBillUpdated={async (updatedBill) => {
                  setBillDetail(updatedBill)
                  qc.invalidateQueries({ queryKey: ['bankbook-day', selectedDate] })
                  qc.invalidateQueries({ queryKey: ['bankbook-all-entries'] })
                  qc.invalidateQueries({ queryKey: ['bankbook-daily-summary'] })
                  qc.invalidateQueries({ queryKey: ['bankbook-payments-day'] })
                  qc.invalidateQueries({ queryKey: ['bankbook-all-payments'] })
                }}
              />
            </Stack>
          )}
        </DialogContent>
      </Dialog>
      <BillEditDialog
        open={billEditOpen}
        bill={billDetail}
        onClose={() => setBillEditOpen(false)}
        onSaved={(updated) => {
          setBillDetail(updated)
          qc.invalidateQueries({ queryKey: ['bankbook-day', selectedDate] })
          qc.invalidateQueries({ queryKey: ['bankbook-all-entries'] })
          qc.invalidateQueries({ queryKey: ['bankbook-daily-summary'] })
          qc.invalidateQueries({ queryKey: ['bankbook-payments-day'] })
          qc.invalidateQueries({ queryKey: ['bankbook-all-payments'] })
        }}
      />
      <Dialog open={!!editRow} onClose={() => setEditRow(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Bank Book Entry</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              select
              label="Entry Type"
              value={editType}
              onChange={(e) => {
                const next = e.target.value as BankbookType
                setEditType(next)
                if (next === 'OPENING') setEditMode('OPENING')
                else if (next === 'CONTRA') setEditMode('BANK_DEPOSIT')
                else if (editMode === 'OPENING') setEditMode('UPI')
              }}
              fullWidth
            >
              <MenuItem value="OPENING">Opening Balance (1 Apr)</MenuItem>
              <MenuItem value="CONTRA">Contra (Bank to Cash)</MenuItem>
              <MenuItem value="RECEIPT">Receipt (Bank In)</MenuItem>
              <MenuItem value="EXPENSE">Expense (Bank Out)</MenuItem>
              <MenuItem value="WITHDRAWAL">Withdrawal (Bank Out)</MenuItem>
            </TextField>
            {editType !== 'OPENING' && editType !== 'CONTRA' ? (
              <TextField
                select
                label="Mode"
                value={editMode}
                onChange={(e) => setEditMode(e.target.value as BankbookMode)}
                fullWidth
              >
                {manualModes.map((mode) => (
                  <MenuItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </MenuItem>
                ))}
              </TextField>
            ) : null}
            <TextField
              label="Entry Date"
              type="date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              fullWidth
            />
            <TextField
              label="Amount"
              type="number"
              value={editAmount}
              onChange={(e) => setEditAmount(e.target.value)}
              inputProps={{ min: 0, step: '0.01' }}
              fullWidth
            />
            <TextField
              label="Txn Charges"
              type="number"
              value={editTxnCharges}
              onChange={(e) => setEditTxnCharges(e.target.value)}
              inputProps={{ min: 0, step: '0.01' }}
              disabled={editType === 'OPENING' || editType === 'CONTRA'}
              fullWidth
            />
            <TextField
              label="Note"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              multiline
              minRows={2}
              fullWidth
            />
            {mUpdate.isError ? (
              <Alert severity="error">{errorMessage(mUpdate.error, 'Failed to update bank record.')}</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditRow(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => mUpdate.mutate()}
            disabled={!editRow || Number(editAmount) <= 0 || !editDate || mUpdate.isPending}
          >
            {mUpdate.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={!!deleteRow}
        onClose={() => {
          if (!mDelete.isPending) setDeleteRow(null)
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Delete Bank Book Entry</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1}>
            <Typography>Delete this bank book entry?</Typography>
            <Typography variant="body2" color="text.secondary">
              {deleteRow ? `${isoDate(deleteRow.created_at)} - ${rowTypeForFilter(deleteRow)} - Rs ${money(deleteRow.amount)}` : ''}
            </Typography>
            {deleteRow?.note ? (
              <Typography variant="body2" color="text.secondary">
                {deleteRow.note}
              </Typography>
            ) : null}
            {mDelete.isError ? (
              <Alert severity="error">{errorMessage(mDelete.error, 'Failed to delete bank record.')}</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteRow(null)} disabled={mDelete.isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              if (deleteRow) mDelete.mutate(deleteRow)
            }}
            disabled={!deleteRow || mDelete.isPending}
          >
            {mDelete.isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
