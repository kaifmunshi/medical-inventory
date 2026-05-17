import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
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
  TableSortLabel,
  TextField,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import RestoreIcon from '@mui/icons-material/Restore'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchCustomers } from '../../services/customers'
import {
  applyPartyReceipt,
  createPartyReceipt,
  deletePartyReceipt,
  fetchCustomerReturns,
  fetchDebtorLedger,
  fetchOpenBills,
  fetchParties,
  fetchPartyReceipts,
  fetchReceiptAdjustments,
  recoverPartyReceipt,
  updatePartyReceipt,
} from '../../services/parties'
import { getBill, listPayments, undoBillPayment, type BillPaymentRow } from '../../services/billing'
import type {
  Customer,
  CustomerReturnLedgerRow,
  DebtorLedgerRow,
  OpenBill,
  Party,
  PartyReceipt,
  ReceiptBillAdjustment,
} from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'
import BillEditDialog from '../../components/billing/BillEditDialog'
import BillPaymentsPanel from '../../components/billing/BillPaymentsPanel'

function money(n: number | string | undefined | null) {
  return Number(n || 0).toFixed(2)
}

function billStatusClass(status: string) {
  const normalized = String(status || 'UNPAID').toUpperCase()
  if (normalized === 'PAID') return 'status-paid'
  if (normalized === 'PARTIAL') return 'status-partial'
  return 'status-unpaid'
}

type SortDirection = 'asc' | 'desc'
type SortState<Key extends string> = { key: Key; direction: SortDirection }
type BillSortKey = 'bill_id' | 'bill_date' | 'total_amount' | 'paid_amount' | 'writeoff_amount' | 'outstanding_amount' | 'payment_status'
type ReceiptSortKey = 'receiptId' | 'when' | 'mode' | 'cash' | 'online' | 'total' | 'adjusted' | 'onAccount'

function compareSortValues(a: string | number, b: string | number) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' })
}

function SortableHeader<Key extends string>({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string
  sortKey: Key
  sort: SortState<Key>
  onSort: (key: Key) => void
  className?: string
}) {
  return (
    <th className={className}>
      <TableSortLabel
        active={sort.key === sortKey}
        direction={sort.key === sortKey ? sort.direction : 'asc'}
        onClick={() => onSort(sortKey)}
      >
        {label}
      </TableSortLabel>
    </th>
  )
}

function MoneyCell({
  value,
  strong = false,
}: {
  value: number | string | undefined | null
  tone?: 'neutral' | 'total' | 'paid' | 'writeoff' | 'pending'
  strong?: boolean
}) {
  const amount = Number(value || 0)
  return (
    <Typography variant="body2" sx={{ fontWeight: strong ? 800 : 500 }}>
      {money(amount)}
    </Typography>
  )
}

const billGridSx = {
  overflowX: 'auto',
  '& .customer-ledger-grid': {
    minWidth: 960,
    tableLayout: 'fixed',
  },
  '& .customer-ledger-grid th': {
    bgcolor: 'rgba(255,255,255,0.98)',
  },
  '& .customer-ledger-grid th .MuiTableSortLabel-root': {
    fontWeight: 700,
  },
  '& .customer-ledger-grid th .MuiTableSortLabel-root.Mui-active': {
    color: '#145c3b',
  },
  '& .customer-ledger-grid tbody tr.detail-row > td': {
    bgcolor: '#f7f8fb',
  },
  '& .expand-col': { width: 42, textAlign: 'center', px: 0.25 },
  '& .bill-col': { width: 100 },
  '& .date-col': { width: 118 },
  '& .amount-col': { width: 96, textAlign: 'right' },
  '& .status-col': { width: 100 },
  '& .notes-col': { width: 220, whiteSpace: 'normal', wordBreak: 'break-word' },
  '& .clip-text': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'block',
  },
} as const

const receiptGridSx = {
  ...billGridSx,
  '& .customer-ledger-grid': {
    minWidth: 1040,
    tableLayout: 'fixed',
  },
  '& .receipt-col': { width: 126 },
  '& .date-col': { width: 118 },
  '& .mode-col': { width: 88 },
  '& .amount-col': { width: 92, textAlign: 'right' },
  '& .allocation-col': { width: 188, whiteSpace: 'normal', wordBreak: 'break-word' },
  '& .action-col': { width: 180, textAlign: 'right' },
} as const

type ReceiptHistoryRow = {
  id: string
  receiptId: number
  billId?: number
  sourceType: 'party_receipt' | 'bill_payment'
  when: string
  source: string
  mode: string
  cash: number
  online: number
  total: number
  adjusted: number
  onAccount: number
  allocation: string
  note: string
  isDeleted?: boolean
  deletedAt?: string | null
}

export default function CustomerLedgerPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const today = new Date().toISOString().slice(0, 10)
  const [params, setParams] = useSearchParams()

  const [customerId, setCustomerId] = useState('')
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [mode, setMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [receiptAmount, setReceiptAmount] = useState('0')
  const [cashAmount, setCashAmount] = useState('0')
  const [onlineAmount, setOnlineAmount] = useState('0')
  const [paymentDate, setPaymentDate] = useState(today)
  const [note, setNote] = useState('')
  const [adjustmentDrafts, setAdjustmentDrafts] = useState<Record<number, string>>({})
  const [billOpen, setBillOpen] = useState(false)
  const [billLoading, setBillLoading] = useState(false)
  const [billDetail, setBillDetail] = useState<any | null>(null)
  const [billEditOpen, setBillEditOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ReceiptHistoryRow | null>(null)
  const [editReceiptTarget, setEditReceiptTarget] = useState<ReceiptHistoryRow | null>(null)
  const [recoverReceiptTarget, setRecoverReceiptTarget] = useState<ReceiptHistoryRow | null>(null)
  const [applyTarget, setApplyTarget] = useState<ReceiptHistoryRow | null>(null)
  const [applyDate, setApplyDate] = useState(today)
  const [applyNote, setApplyNote] = useState('')
  const [applyDrafts, setApplyDrafts] = useState<Record<number, string>>({})
  const [editReceiptMode, setEditReceiptMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [editReceiptAmount, setEditReceiptAmount] = useState('0')
  const [editReceiptCash, setEditReceiptCash] = useState('0')
  const [editReceiptOnline, setEditReceiptOnline] = useState('0')
  const [editReceiptDate, setEditReceiptDate] = useState(today)
  const [editReceiptNote, setEditReceiptNote] = useState('')
  const [openBillSort, setOpenBillSort] = useState<SortState<BillSortKey>>({ key: 'bill_date', direction: 'desc' })
  const [ledgerSort, setLedgerSort] = useState<SortState<BillSortKey>>({ key: 'bill_date', direction: 'desc' })
  const [receiptSort, setReceiptSort] = useState<SortState<ReceiptSortKey>>({ key: 'when', direction: 'desc' })
  const [expandedOpenBills, setExpandedOpenBills] = useState<Record<number, boolean>>({})
  const [expandedLedgerRows, setExpandedLedgerRows] = useState<Record<number, boolean>>({})
  const [expandedReceipts, setExpandedReceipts] = useState<Record<string, boolean>>({})

  const customersQ = useQuery<Customer[], Error>({
    queryKey: ['customer-ledger-customers'],
    queryFn: () => fetchCustomers(),
  })

  const partiesQ = useQuery<Party[], Error>({
    queryKey: ['customer-ledger-parties'],
    queryFn: () => fetchParties({ party_group: 'SUNDRY_DEBTOR', is_active: true }),
  })

  const selectedCustomer = useMemo(
    () => (customersQ.data || []).find((customer) => String(customer.id) === String(customerId || '')),
    [customersQ.data, customerId],
  )

  const selectedParty = useMemo(
    () =>
      (partiesQ.data || []).find((party) => {
        const selectedCustomerId = Number(selectedCustomer?.id || 0)
        const selectedCustomerName = String(selectedCustomer?.name || '').trim().toLowerCase()
        const legacyMatch = Number(party.legacy_customer_id || 0) > 0 && Number(party.legacy_customer_id) === selectedCustomerId
        const nameMatch = selectedCustomerName && String(party.name || '').trim().toLowerCase() === selectedCustomerName
        return legacyMatch || Boolean(nameMatch)
      }),
    [partiesQ.data, selectedCustomer],
  )

  useEffect(() => {
    const id = params.get('customer_id')
    if (id && customersQ.data) {
      const match = customersQ.data.find((customer) => String(customer.id) === id)
      if (match && customerId !== String(match.id)) {
        setCustomerId(String(match.id))
      }
    }
  }, [params, customersQ.data, customerId])

  const ledgerQ = useQuery<DebtorLedgerRow[], Error>({
    queryKey: ['customer-ledger', selectedParty?.id],
    queryFn: () => fetchDebtorLedger(Number(selectedParty?.id)),
    enabled: Boolean(selectedParty?.id),
  })

  const openBillsQ = useQuery<OpenBill[], Error>({
    queryKey: ['customer-open-bills', selectedParty?.id],
    queryFn: () => fetchOpenBills(Number(selectedParty?.id)),
    enabled: Boolean(selectedParty?.id),
  })

  const returnsQ = useQuery<CustomerReturnLedgerRow[], Error>({
    queryKey: ['customer-returns', selectedParty?.id],
    queryFn: () => fetchCustomerReturns(Number(selectedParty?.id)),
    enabled: Boolean(selectedParty?.id),
  })

  const receiptsQ = useQuery<PartyReceipt[], Error>({
    queryKey: ['customer-receipts', selectedParty?.id],
    queryFn: () => fetchPartyReceipts(Number(selectedParty?.id), { deleted_filter: 'all' }),
    enabled: Boolean(selectedParty?.id),
  })

  const receiptAdjustmentsQ = useQuery<ReceiptBillAdjustment[], Error>({
    queryKey: ['customer-receipt-adjustments', selectedParty?.id],
    queryFn: () => fetchReceiptAdjustments(Number(selectedParty?.id)),
    enabled: Boolean(selectedParty?.id),
  })

  const allPaymentsQ = useQuery<BillPaymentRow[], Error>({
    queryKey: ['customer-ledger-bill-payments', selectedParty?.id],
    queryFn: async () => {
      const out: BillPaymentRow[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listPayments({ limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: Boolean(selectedParty?.id),
  })

  const receiptM = useMutation({
    mutationFn: ({
      partyId,
      payload,
    }: {
      partyId: number
      payload: {
        mode: 'cash' | 'online' | 'split'
        cash_amount?: number
        online_amount?: number
        note?: string
        payment_date?: string
        adjustments: Array<{ bill_id: number; amount: number }>
      }
    }) => createPartyReceipt(partyId, payload),
    onSuccess: () => {
      toast.push('Receipt recorded', 'success')
      refreshLedgerQueries()
      setReceiptOpen(false)
      setMode('cash')
      setReceiptAmount('0')
      setCashAmount('0')
      setOnlineAmount('0')
      setPaymentDate(today)
      setNote('')
      setAdjustmentDrafts({})
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to record receipt'), 'error'),
  })

  const deleteReceiptM = useMutation({
    mutationFn: async (row: ReceiptHistoryRow) => {
      if (row.sourceType === 'party_receipt') {
        if (!selectedParty?.id) throw new Error('Customer missing')
        return deletePartyReceipt(Number(selectedParty.id), Number(row.receiptId))
      }
      if (!row.billId) throw new Error('Bill missing')
      return undoBillPayment(Number(row.billId), Number(row.receiptId))
    },
    onSuccess: async (_data, row) => {
      toast.push(row.sourceType === 'party_receipt' ? 'Receipt deleted' : 'Bill payment deleted', 'success')
      setDeleteTarget(null)
      refreshLedgerQueries()
      if (billDetail?.id) {
        try {
          setBillDetail(await getBill(Number(billDetail.id)))
        } catch {
          // Keep the current bill dialog open even if the refresh fails.
        }
      }
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to delete receipt'), 'error'),
  })

  const applyReceiptM = useMutation({
    mutationFn: ({
      partyId,
      receiptId,
      payload,
    }: {
      partyId: number
      receiptId: number
      payload: {
        payment_date?: string
        note?: string
        adjustments: Array<{ bill_id: number; amount: number }>
      }
    }) => applyPartyReceipt(partyId, receiptId, payload),
    onSuccess: () => {
      toast.push('Advance applied to bills', 'success')
      setApplyTarget(null)
      setApplyDate(today)
      setApplyNote('')
      setApplyDrafts({})
      refreshLedgerQueries()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to apply advance'), 'error'),
  })

  const editReceiptM = useMutation({
    mutationFn: ({
      partyId,
      receiptId,
      payload,
    }: {
      partyId: number
      receiptId: number
      payload: {
        mode: 'cash' | 'online' | 'split'
        cash_amount?: number
        online_amount?: number
        note?: string
        payment_date?: string
      }
    }) => updatePartyReceipt(partyId, receiptId, payload),
    onSuccess: () => {
      toast.push('Receipt updated', 'success')
      setEditReceiptTarget(null)
      refreshLedgerQueries()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to update receipt'), 'error'),
  })

  const recoverReceiptM = useMutation({
    mutationFn: ({ partyId, receiptId }: { partyId: number; receiptId: number }) => recoverPartyReceipt(partyId, receiptId),
    onSuccess: () => {
      toast.push('Receipt recovered', 'success')
      setRecoverReceiptTarget(null)
      refreshLedgerQueries()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to recover receipt'), 'error'),
  })

  const ledgerRows = ledgerQ.data || []
  const openBills = openBillsQ.data || []
  const returnRows = returnsQ.data || []
  const receipts = receiptsQ.data || []
  const adjustments = receiptAdjustmentsQ.data || []
  const totalOutstanding = ledgerRows.reduce((sum, row) => sum + Number(row.outstanding_amount || 0), 0)
  const totalReturnCredit = returnRows.reduce((sum, row) => sum + Number(row.credit_amount || 0), 0)
  const totalReturnRefund = returnRows.reduce((sum, row) => sum + Number(row.refund_cash || 0) + Number(row.refund_online || 0), 0)
  const adjustmentTotal = Object.values(adjustmentDrafts).reduce((sum, value) => sum + Number(value || 0), 0)
  const receiptTotal = Number(receiptAmount || 0)
  const receiptCashAmount = mode === 'cash' ? receiptTotal : mode === 'online' ? 0 : Number(cashAmount || 0)
  const receiptOnlineAmount = mode === 'online' ? receiptTotal : mode === 'cash' ? 0 : Number(onlineAmount || 0)
  const editReceiptTotal = Number(editReceiptAmount || 0)
  const editReceiptCashAmount = editReceiptMode === 'cash' ? editReceiptTotal : editReceiptMode === 'online' ? 0 : Number(editReceiptCash || 0)
  const editReceiptOnlineAmount = editReceiptMode === 'online' ? editReceiptTotal : editReceiptMode === 'cash' ? 0 : Number(editReceiptOnline || 0)
  const editReceiptApplied = Number(editReceiptTarget?.adjusted || 0)
  const editReceiptAdvance = Math.max(0, editReceiptTotal - editReceiptApplied)
  const onAccountAmount = Math.max(0, receiptTotal - adjustmentTotal)
  const applyAvailable = Number(applyTarget?.onAccount || 0)
  const applyAdjustmentTotal = Object.values(applyDrafts).reduce((sum, value) => sum + Number(value || 0), 0)
  const applyRemaining = Math.max(0, applyAvailable - applyAdjustmentTotal)
  const openBillsForReceipt = useMemo(
    () =>
      [...openBills].sort((a, b) => {
        const byDate = String(a.bill_date || '').localeCompare(String(b.bill_date || ''))
        if (byDate !== 0) return byDate
        return Number(a.bill_id || 0) - Number(b.bill_id || 0)
      }),
    [openBills],
  )

  const adjustmentMap = useMemo(() => {
    const map = new Map<number, number>()
    for (const row of adjustments) {
      map.set(Number(row.receipt_id), (map.get(Number(row.receipt_id)) || 0) + Number(row.adjusted_amount || 0))
    }
    return map
  }, [adjustments])

  const adjustmentDetails = useMemo(() => {
    const map = new Map<number, ReceiptBillAdjustment[]>()
    for (const row of adjustments) {
      const receiptId = Number(row.receipt_id)
      const existing = map.get(receiptId) || []
      existing.push(row)
      map.set(receiptId, existing)
    }
    return map
  }, [adjustments])

  const receiptHistory = useMemo<ReceiptHistoryRow[]>(() => {
    const billIds = new Set(ledgerRows.map((row) => Number(row.bill_id)))
    const partyReceiptRows = receipts.map((receipt) => {
      const lines = adjustmentDetails.get(Number(receipt.id)) || []
      const adjusted = adjustmentMap.get(Number(receipt.id)) || 0
      const allocation =
        lines.length > 0
          ? lines.map((line) => `Bill #${line.bill_id}: ${money(line.adjusted_amount)}`).join(', ')
          : Number(receipt.unallocated_amount || 0) > 0
            ? 'Advance / on account'
            : '-'
      return {
        id: `party-${receipt.id}`,
        receiptId: receipt.id,
        sourceType: 'party_receipt' as const,
        when: receipt.received_at,
        source: 'Customer receipt',
        mode: receipt.mode,
        cash: Number(receipt.cash_amount || 0),
        online: Number(receipt.online_amount || 0),
        total: Number(receipt.total_amount || 0),
        adjusted,
        onAccount: Number(receipt.unallocated_amount || 0),
        allocation,
        note: receipt.note || '',
        isDeleted: Boolean(receipt.is_deleted),
        deletedAt: receipt.deleted_at || null,
      }
    })

    const directPaymentRows = ((allPaymentsQ.data || []) as any[])
      .filter((payment) => billIds.has(Number(payment.bill_id)))
      .filter((payment) => !payment.is_writeoff && Number(payment.writeoff_amount || 0) <= 0)
      .filter((payment) => !/^party receipt #/i.test(String(payment.note || '').trim()))
      .map((payment) => {
        const cash = Number(payment.cash_amount || 0)
        const online = Number(payment.online_amount || 0)
        const total = cash + online
        return {
          id: `bill-payment-${payment.id}`,
          receiptId: payment.id,
          billId: Number(payment.bill_id),
          sourceType: 'bill_payment' as const,
          when: payment.received_at,
          source: 'Bill payment',
          mode: payment.mode,
          cash,
          online,
          total,
          adjusted: total,
          onAccount: 0,
          allocation: `Bill #${payment.bill_id}: ${money(total)}`,
          note: payment.note || '',
          isDeleted: false,
          deletedAt: null,
        }
      })

    return [...partyReceiptRows, ...directPaymentRows].sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')))
  }, [adjustmentDetails, adjustmentMap, allPaymentsQ.data, ledgerRows, receipts])
  const activeReceiptHistory = receiptHistory.filter((row) => !row.isDeleted)
  const receiptHistoryTotal = activeReceiptHistory.reduce((sum, row) => sum + Number(row.total || 0), 0)
  const receiptHistoryOnAccountTotal = activeReceiptHistory.reduce((sum, row) => sum + Number(row.onAccount || 0), 0)

  function billSortValue(row: DebtorLedgerRow | OpenBill, key: BillSortKey): string | number {
    if (key === 'payment_status') {
      const normalized = String(row.payment_status || 'UNPAID').toUpperCase()
      if (normalized === 'UNPAID') return 0
      if (normalized === 'PARTIAL') return 1
      if (normalized === 'PAID') return 2
      return normalized
    }
    return key === 'bill_date' ? String(row.bill_date || '') : Number(row[key] || 0)
  }

  function receiptSortValue(row: ReceiptHistoryRow, key: ReceiptSortKey): string | number {
    if (key === 'when' || key === 'mode') return String(row[key] || '')
    return Number(row[key] || 0)
  }

  function sortBills<T extends DebtorLedgerRow | OpenBill>(rows: T[], sort: SortState<BillSortKey>) {
    const dir = sort.direction === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const primary = compareSortValues(billSortValue(a, sort.key), billSortValue(b, sort.key))
      if (primary !== 0) return primary * dir
      return (Number(b.bill_id || 0) - Number(a.bill_id || 0))
    })
  }

  function sortReceipts(rows: ReceiptHistoryRow[], sort: SortState<ReceiptSortKey>) {
    const dir = sort.direction === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const primary = compareSortValues(receiptSortValue(a, sort.key), receiptSortValue(b, sort.key))
      if (primary !== 0) return primary * dir
      return String(b.id || '').localeCompare(String(a.id || ''), undefined, { numeric: true })
    })
  }

  function nextSort<Key extends string>(current: SortState<Key>, key: Key): SortState<Key> {
    return {
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }
  }

  const sortedOpenBills = useMemo(() => sortBills(openBills, openBillSort), [openBills, openBillSort])
  const sortedLedgerRows = useMemo(() => sortBills(ledgerRows, ledgerSort), [ledgerRows, ledgerSort])
  const sortedReceiptHistory = useMemo(() => sortReceipts(receiptHistory, receiptSort), [receiptHistory, receiptSort])

  function openReceiptDialog() {
    setAdjustmentDrafts(
      Object.fromEntries(openBills.map((bill) => [Number(bill.bill_id), '0'])),
    )
    setMode('cash')
    setReceiptAmount('0')
    setCashAmount('0')
    setOnlineAmount('0')
    setPaymentDate(today)
    setNote('')
    setReceiptOpen(true)
  }

  function setDraft(billId: number, value: string) {
    setAdjustmentDrafts((prev) => ({ ...prev, [billId]: value }))
  }

  function setReceiptMode(next: 'cash' | 'online' | 'split') {
    setMode(next)
    const total = String(receiptAmount || '0')
    if (next === 'cash') {
      setCashAmount(total)
      setOnlineAmount('0')
    } else if (next === 'online') {
      setCashAmount('0')
      setOnlineAmount(total)
    } else {
      setCashAmount(total)
      setOnlineAmount('0')
    }
  }

  function handleReceiptAmountChange(raw: string) {
    setReceiptAmount(raw)
    if (mode === 'cash') {
      setCashAmount(raw)
      setOnlineAmount('0')
    } else if (mode === 'online') {
      setCashAmount('0')
      setOnlineAmount(raw)
    } else {
      setCashAmount(raw)
      setOnlineAmount('0')
    }
  }

  function setEditReceiptModeValue(next: 'cash' | 'online' | 'split') {
    setEditReceiptMode(next)
    const total = String(editReceiptAmount || '0')
    if (next === 'cash') {
      setEditReceiptCash(total)
      setEditReceiptOnline('0')
    } else if (next === 'online') {
      setEditReceiptCash('0')
      setEditReceiptOnline(total)
    } else {
      setEditReceiptCash(total)
      setEditReceiptOnline('0')
    }
  }

  function handleEditReceiptAmountChange(raw: string) {
    setEditReceiptAmount(raw)
    if (editReceiptMode === 'cash') {
      setEditReceiptCash(raw)
      setEditReceiptOnline('0')
    } else if (editReceiptMode === 'online') {
      setEditReceiptCash('0')
      setEditReceiptOnline(raw)
    } else {
      setEditReceiptCash(raw)
      setEditReceiptOnline('0')
    }
  }

  function setEditSplitCash(raw: string) {
    setEditReceiptCash(raw)
    setEditReceiptAmount(String(Number(raw || 0) + Number(editReceiptOnline || 0)))
  }

  function setEditSplitOnline(raw: string) {
    setEditReceiptOnline(raw)
    setEditReceiptAmount(String(Number(editReceiptCash || 0) + Number(raw || 0)))
  }

  function setSplitCash(raw: string) {
    setCashAmount(raw)
    setReceiptAmount(String(Number(raw || 0) + Number(onlineAmount || 0)))
  }

  function setSplitOnline(raw: string) {
    setOnlineAmount(raw)
    setReceiptAmount(String(Number(cashAmount || 0) + Number(raw || 0)))
  }

  function fillBillAdjustmentOnFocus(bill: OpenBill) {
    const billId = Number(bill.bill_id)
    const current = Number(adjustmentDrafts[billId] || 0)
    if (current > 0) return
    const usedElsewhere = Object.entries(adjustmentDrafts).reduce((sum, [id, value]) => {
      return Number(id) === billId ? sum : sum + Number(value || 0)
    }, 0)
    const remaining = Math.max(0, receiptTotal - usedElsewhere)
    if (remaining <= 0) return
    setDraft(billId, String(Math.min(Number(bill.outstanding_amount || 0), remaining)))
  }

  function clampBillAdjustment(bill: OpenBill) {
    const billId = Number(bill.bill_id)
    const raw = Number(adjustmentDrafts[billId] || 0)
    if (!Number.isFinite(raw) || raw <= 0) {
      setDraft(billId, '0')
      return
    }
    setDraft(billId, String(Math.min(raw, Number(bill.outstanding_amount || 0))))
  }

  function fillAdjustmentsFromReceipt() {
    let remaining = receiptTotal
    const next: Record<number, string> = {}
    for (const bill of openBillsForReceipt) {
      const amount = Math.min(Number(bill.outstanding_amount || 0), Math.max(0, remaining))
      next[Number(bill.bill_id)] = amount > 0 ? String(amount) : '0'
      remaining = Math.max(0, remaining - amount)
    }
    setAdjustmentDrafts(next)
  }

  function clearReceiptAdjustments() {
    setAdjustmentDrafts(
      Object.fromEntries(openBillsForReceipt.map((bill) => [Number(bill.bill_id), '0'])),
    )
  }

  function openApplyAdvance(row: ReceiptHistoryRow) {
    setApplyTarget(row)
    setApplyDate(today)
    setApplyNote('')
    setApplyDrafts(Object.fromEntries(openBillsForReceipt.map((bill) => [Number(bill.bill_id), '0'])))
  }

  function openEditReceipt(row: ReceiptHistoryRow) {
    if (row.isDeleted || row.sourceType !== 'party_receipt') return
    const cash = Number(row.cash || 0)
    const online = Number(row.online || 0)
    const total = Number(row.total || cash + online)
    const normalizedMode =
      cash > 0 && online > 0
        ? 'split'
        : String(row.mode || '').toLowerCase() === 'online'
          ? 'online'
          : String(row.mode || '').toLowerCase() === 'split'
            ? 'split'
            : 'cash'
    setEditReceiptTarget(row)
    setEditReceiptMode(normalizedMode)
    setEditReceiptAmount(String(total))
    setEditReceiptCash(String(cash))
    setEditReceiptOnline(String(online))
    setEditReceiptDate(String(row.when || today).slice(0, 10))
    setEditReceiptNote(row.note || '')
  }

  function setApplyDraft(billId: number, value: string) {
    setApplyDrafts((prev) => ({ ...prev, [billId]: value }))
  }

  function fillApplyAdjustmentOnFocus(bill: OpenBill) {
    const billId = Number(bill.bill_id)
    const current = Number(applyDrafts[billId] || 0)
    if (current > 0) return
    const usedElsewhere = Object.entries(applyDrafts).reduce((sum, [id, value]) => {
      return Number(id) === billId ? sum : sum + Number(value || 0)
    }, 0)
    const remaining = Math.max(0, applyAvailable - usedElsewhere)
    if (remaining <= 0) return
    setApplyDraft(billId, String(Math.min(Number(bill.outstanding_amount || 0), remaining)))
  }

  function clampApplyAdjustment(bill: OpenBill) {
    const billId = Number(bill.bill_id)
    const raw = Number(applyDrafts[billId] || 0)
    if (!Number.isFinite(raw) || raw <= 0) {
      setApplyDraft(billId, '0')
      return
    }
    const usedElsewhere = Object.entries(applyDrafts).reduce((sum, [id, value]) => {
      return Number(id) === billId ? sum : sum + Number(value || 0)
    }, 0)
    const remaining = Math.max(0, applyAvailable - usedElsewhere)
    setApplyDraft(billId, String(Math.min(raw, Number(bill.outstanding_amount || 0), remaining)))
  }

  function fillApplyFromAdvance() {
    let remaining = applyAvailable
    const next: Record<number, string> = {}
    for (const bill of openBillsForReceipt) {
      const amount = Math.min(Number(bill.outstanding_amount || 0), Math.max(0, remaining))
      next[Number(bill.bill_id)] = amount > 0 ? String(amount) : '0'
      remaining = Math.max(0, remaining - amount)
    }
    setApplyDrafts(next)
  }

  function clearApplyAdjustments() {
    setApplyDrafts(Object.fromEntries(openBillsForReceipt.map((bill) => [Number(bill.bill_id), '0'])))
  }

  async function openBillDetail(billId: number) {
    if (!Number.isFinite(billId) || billId <= 0) return
    setBillOpen(true)
    setBillLoading(true)
    setBillDetail(null)
    try {
      const data = await getBill(billId)
      setBillDetail(data)
    } catch {
      setBillDetail(null)
    } finally {
      setBillLoading(false)
    }
  }

  function refreshLedgerQueries() {
    queryClient.invalidateQueries({ queryKey: ['customer-ledger'] })
    queryClient.invalidateQueries({ queryKey: ['customer-open-bills'] })
    queryClient.invalidateQueries({ queryKey: ['customer-returns'] })
    queryClient.invalidateQueries({ queryKey: ['customer-receipts'] })
    queryClient.invalidateQueries({ queryKey: ['customer-receipt-adjustments'] })
    queryClient.invalidateQueries({ queryKey: ['customer-ledger-bill-payments'] })
    queryClient.invalidateQueries({ queryKey: ['bill-payments-panel'] })
    queryClient.invalidateQueries({ queryKey: ['credit-bills'] })
    queryClient.invalidateQueries({ queryKey: ['cashbook-day'] })
    queryClient.invalidateQueries({ queryKey: ['cashbook-all-entries'] })
    queryClient.invalidateQueries({ queryKey: ['cashbook-daily-summary'] })
    queryClient.invalidateQueries({ queryKey: ['cashbook-payments-day'] })
    queryClient.invalidateQueries({ queryKey: ['cashbook-all-payments'] })
    queryClient.invalidateQueries({ queryKey: ['cashbook-receipts-day'] })
    queryClient.invalidateQueries({ queryKey: ['cashbook-all-receipts'] })
    queryClient.invalidateQueries({ queryKey: ['bankbook-day'] })
    queryClient.invalidateQueries({ queryKey: ['bankbook-all-entries'] })
    queryClient.invalidateQueries({ queryKey: ['bankbook-daily-summary'] })
    queryClient.invalidateQueries({ queryKey: ['bankbook-payments-day'] })
    queryClient.invalidateQueries({ queryKey: ['bankbook-all-payments'] })
    queryClient.invalidateQueries({ queryKey: ['bankbook-receipts-day'] })
    queryClient.invalidateQueries({ queryKey: ['bankbook-all-receipts'] })
    queryClient.invalidateQueries({ queryKey: ['dash-cashbook'] })
    queryClient.invalidateQueries({ queryKey: ['dash-cashbook-history'] })
    queryClient.invalidateQueries({ queryKey: ['dash-cashbook-history-summary'] })
  }

  function renderBillRefs(text: string) {
    const raw = String(text || '-')
    if (raw === '-') return raw
    return raw.split(/(Bill #\d+)/g).map((part, index) => {
      const match = /^Bill #(\d+)$/.exec(part)
      if (!match) return part
      return (
        <Link
          key={`${part}-${index}`}
          component="button"
          underline="hover"
          onClick={() => openBillDetail(Number(match[1]))}
          sx={{ fontWeight: 600, verticalAlign: 'baseline' }}
        >
          {part}
        </Link>
      )
    })
  }

  function saveReceipt() {
    if (!selectedParty?.id) return
    receiptM.mutate({
      partyId: Number(selectedParty.id),
      payload: {
        mode,
        cash_amount: receiptCashAmount,
        online_amount: receiptOnlineAmount,
        payment_date: paymentDate,
        note: note.trim() || undefined,
        adjustments: openBills
          .map((bill) => ({
            bill_id: Number(bill.bill_id),
            amount: Number(adjustmentDrafts[Number(bill.bill_id)] || 0),
          }))
          .filter((adj) => adj.amount > 0),
      },
    })
  }

  function saveApplyAdvance() {
    if (!selectedParty?.id || !applyTarget?.receiptId) return
    applyReceiptM.mutate({
      partyId: Number(selectedParty.id),
      receiptId: Number(applyTarget.receiptId),
      payload: {
        payment_date: applyDate,
        note: applyNote.trim() || undefined,
        adjustments: openBills
          .map((bill) => ({
            bill_id: Number(bill.bill_id),
            amount: Number(applyDrafts[Number(bill.bill_id)] || 0),
          }))
          .filter((adj) => adj.amount > 0),
      },
    })
  }

  function saveEditReceipt() {
    if (!selectedParty?.id || !editReceiptTarget?.receiptId) return
    editReceiptM.mutate({
      partyId: Number(selectedParty.id),
      receiptId: Number(editReceiptTarget.receiptId),
      payload: {
        mode: editReceiptMode,
        cash_amount: editReceiptCashAmount,
        online_amount: editReceiptOnlineAmount,
        payment_date: editReceiptDate,
        note: editReceiptNote.trim() || undefined,
      },
    })
  }

  function saveRecoverReceipt() {
    if (!selectedParty?.id || !recoverReceiptTarget?.receiptId) return
    recoverReceiptM.mutate({
      partyId: Number(selectedParty.id),
      receiptId: Number(recoverReceiptTarget.receiptId),
    })
  }

  return (
    <Stack gap={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
        <Typography variant="h5">Customer Ledger</Typography>
        <Button variant="contained" onClick={openReceiptDialog} disabled={!selectedParty}>
          Record Receipt
        </Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <TextField
          select
          label="Customer"
          value={customerId}
          onChange={(e) => {
            const nextId = String(e.target.value || '')
            setCustomerId(nextId)
            const newParams = new URLSearchParams(params)
            if (nextId) newParams.set('customer_id', nextId)
            else newParams.delete('customer_id')
            setParams(newParams, { replace: true })
          }}
          fullWidth
        >
          {(customersQ.data || []).map((customer) => (
            <MenuItem key={customer.id} value={String(customer.id)}>
              {[customer.name, customer.phone].filter(Boolean).join(' • ')}
            </MenuItem>
          ))}
        </TextField>
      </Paper>

      {selectedCustomer && (
        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={2} justifyContent="space-between" alignItems={{ md: 'center' }}>
            <div>
              <Typography fontWeight={700}>{selectedCustomer.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {[selectedCustomer.phone, selectedCustomer.address_line].filter(Boolean).join(' • ') || 'Customer master record'}
              </Typography>
            </div>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} flexWrap="wrap" useFlexGap>
              <Chip color={totalOutstanding > 0 ? 'error' : 'success'} label={`Outstanding Rs ${money(totalOutstanding)}`} sx={{ fontWeight: 900 }} />
              <Chip color="primary" variant="outlined" label={`Open Bills ${openBills.length}`} sx={{ fontWeight: 800 }} />
              <Chip color="warning" variant="outlined" label={`Return Credit Rs ${money(totalReturnCredit)}`} sx={{ fontWeight: 800 }} />
              <Chip color="secondary" variant="outlined" label={`Return Refund Rs ${money(totalReturnRefund)}`} sx={{ fontWeight: 800 }} />
              <Chip color="success" variant="outlined" label={`Receipts Rs ${money(receiptHistoryTotal)}`} sx={{ fontWeight: 800 }} />
              <Chip color="info" variant="outlined" label={`Advance Rs ${money(receiptHistoryOnAccountTotal)}`} sx={{ fontWeight: 800 }} />
            </Stack>
          </Stack>
        </Paper>
      )}

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Open Bills</Typography>
        <Box sx={billGridSx}>
          <table className="table customer-ledger-grid">
            <thead>
              <tr>
                <th className="expand-col"></th>
                <SortableHeader label="Bill" sortKey="bill_id" sort={openBillSort} onSort={(key) => setOpenBillSort((prev) => nextSort(prev, key))} className="bill-col" />
                <SortableHeader label="Date" sortKey="bill_date" sort={openBillSort} onSort={(key) => setOpenBillSort((prev) => nextSort(prev, key))} className="date-col" />
                <SortableHeader label="Total" sortKey="total_amount" sort={openBillSort} onSort={(key) => setOpenBillSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Paid" sortKey="paid_amount" sort={openBillSort} onSort={(key) => setOpenBillSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Write-off" sortKey="writeoff_amount" sort={openBillSort} onSort={(key) => setOpenBillSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Pending" sortKey="outstanding_amount" sort={openBillSort} onSort={(key) => setOpenBillSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Status" sortKey="payment_status" sort={openBillSort} onSort={(key) => setOpenBillSort((prev) => nextSort(prev, key))} className="status-col" />
                <th className="notes-col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {sortedOpenBills.map((row) => {
                const billId = Number(row.bill_id)
                const isExpanded = Boolean(expandedOpenBills[billId])
                return (
                  <Fragment key={row.bill_id}>
                    <tr className={billStatusClass(row.payment_status)}>
                      <td className="expand-col">
                        <IconButton
                          size="small"
                          onClick={() => setExpandedOpenBills((prev) => ({ ...prev, [billId]: !prev[billId] }))}
                        >
                          {isExpanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
                        </IconButton>
                      </td>
                      <td>
                        <Stack gap={0.25}>
                          <Link
                            component="button"
                            underline="hover"
                            onClick={() => openBillDetail(billId)}
                            sx={{ fontWeight: 800 }}
                          >
                            Bill #{row.bill_id}
                          </Link>
                        </Stack>
                      </td>
                      <td className="date-col">
                        <Typography variant="body2">{row.bill_date || '-'}</Typography>
                      </td>
                      <td className="amount-col"><MoneyCell value={row.total_amount} tone="total" /></td>
                      <td className="amount-col"><MoneyCell value={row.paid_amount} tone="paid" /></td>
                      <td className="amount-col"><MoneyCell value={row.writeoff_amount} tone="writeoff" /></td>
                      <td className="amount-col"><MoneyCell value={row.outstanding_amount} tone="pending" strong /></td>
                      <td>{statusChip(row.payment_status)}</td>
                      <td className="notes-col">
                        <Typography variant="body2" className="clip-text">{row.notes || '-'}</Typography>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="detail-row">
                        <td colSpan={9}>
                          <Stack gap={1}>
                            <Typography variant="body2" sx={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                              <b>Notes:</b> {row.notes || '-'}
                            </Typography>
                            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5} flexWrap="wrap" useFlexGap>
                              <Typography variant="caption">Bill date: <b>{row.bill_date || '-'}</b></Typography>
                              <Typography variant="caption">Total: <b>Rs {money(row.total_amount)}</b></Typography>
                              <Typography variant="caption">Paid: <b>Rs {money(row.paid_amount)}</b></Typography>
                              <Typography variant="caption">Write-off: <b>Rs {money(row.writeoff_amount)}</b></Typography>
                              <Typography variant="caption">Pending: <b>Rs {money(row.outstanding_amount)}</b></Typography>
                            </Stack>
                          </Stack>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
              {openBills.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <Box p={2} color="text.secondary">
                      {selectedParty ? 'No open bills for this customer.' : 'Select a customer to view open bills.'}
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Bill Ledger</Typography>
        <Box sx={billGridSx}>
          <table className="table customer-ledger-grid">
            <thead>
              <tr>
                <th className="expand-col"></th>
                <SortableHeader label="Bill" sortKey="bill_id" sort={ledgerSort} onSort={(key) => setLedgerSort((prev) => nextSort(prev, key))} className="bill-col" />
                <SortableHeader label="Date" sortKey="bill_date" sort={ledgerSort} onSort={(key) => setLedgerSort((prev) => nextSort(prev, key))} className="date-col" />
                <SortableHeader label="Total" sortKey="total_amount" sort={ledgerSort} onSort={(key) => setLedgerSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Paid" sortKey="paid_amount" sort={ledgerSort} onSort={(key) => setLedgerSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Write-off" sortKey="writeoff_amount" sort={ledgerSort} onSort={(key) => setLedgerSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Pending" sortKey="outstanding_amount" sort={ledgerSort} onSort={(key) => setLedgerSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Status" sortKey="payment_status" sort={ledgerSort} onSort={(key) => setLedgerSort((prev) => nextSort(prev, key))} className="status-col" />
                <th className="notes-col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {sortedLedgerRows.map((row) => {
                const billId = Number(row.bill_id)
                const isExpanded = Boolean(expandedLedgerRows[billId])
                return (
                  <Fragment key={row.bill_id}>
                    <tr className={billStatusClass(row.payment_status)}>
                      <td className="expand-col">
                        <IconButton
                          size="small"
                          onClick={() => setExpandedLedgerRows((prev) => ({ ...prev, [billId]: !prev[billId] }))}
                        >
                          {isExpanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
                        </IconButton>
                      </td>
                      <td>
                        <Stack gap={0.25}>
                          <Link
                            component="button"
                            underline="hover"
                            onClick={() => openBillDetail(billId)}
                            sx={{ fontWeight: 800 }}
                          >
                            Bill #{row.bill_id}
                          </Link>
                        </Stack>
                      </td>
                      <td className="date-col">
                        <Typography variant="body2">{row.bill_date || '-'}</Typography>
                      </td>
                      <td className="amount-col"><MoneyCell value={row.total_amount} tone="total" /></td>
                      <td className="amount-col"><MoneyCell value={row.paid_amount} tone="paid" /></td>
                      <td className="amount-col"><MoneyCell value={row.writeoff_amount} tone="writeoff" /></td>
                      <td className="amount-col"><MoneyCell value={row.outstanding_amount} tone="pending" strong /></td>
                      <td>{statusChip(row.payment_status)}</td>
                      <td className="notes-col">
                        <Typography variant="body2" className="clip-text">{row.notes || '-'}</Typography>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="detail-row">
                        <td colSpan={9}>
                          <Stack gap={1}>
                            <Typography variant="body2" sx={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                              <b>Notes:</b> {row.notes || '-'}
                            </Typography>
                            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5} flexWrap="wrap" useFlexGap>
                              <Typography variant="caption">Customer: <b>{row.customer_name || '-'}</b></Typography>
                              <Typography variant="caption">Bill date: <b>{row.bill_date || '-'}</b></Typography>
                              <Typography variant="caption">Total: <b>Rs {money(row.total_amount)}</b></Typography>
                              <Typography variant="caption">Paid: <b>Rs {money(row.paid_amount)}</b></Typography>
                              <Typography variant="caption">Write-off: <b>Rs {money(row.writeoff_amount)}</b></Typography>
                              <Typography variant="caption">Pending: <b>Rs {money(row.outstanding_amount)}</b></Typography>
                            </Stack>
                          </Stack>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
              {ledgerRows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <Box p={2} color="text.secondary">
                      {selectedParty ? 'No debtor ledger rows for this customer yet.' : 'Select a customer to view the ledger.'}
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Return History</Typography>
        <Box sx={receiptGridSx}>
          <table className="table customer-ledger-grid">
            <thead>
              <tr>
                <th className="receipt-col">Return</th>
                <th className="date-col">Date</th>
                <th className="bill-col">Source Bill</th>
                <th className="mode-col">Mode</th>
                <th className="amount-col">Credit</th>
                <th className="amount-col">Cash Refund</th>
                <th className="amount-col">Online Refund</th>
                <th className="amount-col">Return Total</th>
                <th className="allocation-col">Exchange</th>
                <th className="allocation-col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {returnRows.map((row) => (
                <tr key={row.return_id}>
                  <td>
                    <Typography fontWeight={800}>Return #{row.return_id}</Typography>
                  </td>
                  <td className="date-col">
                    <Typography variant="body2">{row.date_time || '-'}</Typography>
                  </td>
                  <td>
                    {row.source_bill_id ? (
                      <Link
                        component="button"
                        underline="hover"
                        onClick={() => openBillDetail(Number(row.source_bill_id))}
                        sx={{ fontWeight: 800 }}
                      >
                        Bill #{row.source_bill_id}
                      </Link>
                    ) : '-'}
                  </td>
                  <td>{modeChip(row.refund_mode)}</td>
                  <td className="amount-col"><MoneyCell value={row.credit_amount} strong={Number(row.credit_amount || 0) > 0} /></td>
                  <td className="amount-col"><MoneyCell value={row.refund_cash} /></td>
                  <td className="amount-col"><MoneyCell value={row.refund_online} /></td>
                  <td className="amount-col"><MoneyCell value={row.subtotal_return} strong /></td>
                  <td className="allocation-col">
                    {row.exchange_id ? (
                      <Typography variant="body2" className="clip-text">
                        Exchange #{row.exchange_id}
                        {row.exchange_new_bill_id ? ` / New Bill #${row.exchange_new_bill_id}` : ''}
                      </Typography>
                    ) : '-'}
                  </td>
                  <td className="allocation-col">
                    <Typography variant="body2" className="clip-text">{row.notes || '-'}</Typography>
                  </td>
                </tr>
              ))}
              {returnRows.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    <Box p={2} color="text.secondary">
                      {selectedParty ? 'No returns recorded for this customer yet.' : 'Select a customer to view returns.'}
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Receipt History</Typography>
        <Box sx={receiptGridSx}>
          <table className="table customer-ledger-grid">
            <thead>
              <tr>
                <th className="expand-col"></th>
                <SortableHeader label="Receipt" sortKey="receiptId" sort={receiptSort} onSort={(key) => setReceiptSort((prev) => nextSort(prev, key))} className="receipt-col" />
                <SortableHeader label="Date" sortKey="when" sort={receiptSort} onSort={(key) => setReceiptSort((prev) => nextSort(prev, key))} className="date-col" />
                <SortableHeader label="Mode" sortKey="mode" sort={receiptSort} onSort={(key) => setReceiptSort((prev) => nextSort(prev, key))} className="mode-col" />
                <SortableHeader label="Cash" sortKey="cash" sort={receiptSort} onSort={(key) => setReceiptSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Online" sortKey="online" sort={receiptSort} onSort={(key) => setReceiptSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Total" sortKey="total" sort={receiptSort} onSort={(key) => setReceiptSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Applied" sortKey="adjusted" sort={receiptSort} onSort={(key) => setReceiptSort((prev) => nextSort(prev, key))} className="amount-col" />
                <SortableHeader label="Advance" sortKey="onAccount" sort={receiptSort} onSort={(key) => setReceiptSort((prev) => nextSort(prev, key))} className="amount-col" />
                <th className="allocation-col">Allocation</th>
                <th className="action-col"></th>
              </tr>
            </thead>
            <tbody>
              {sortedReceiptHistory.map((receipt) => {
                const isExpanded = Boolean(expandedReceipts[receipt.id])
                const rowClass = receipt.isDeleted
                  ? 'receipt-deleted'
                  : Number(receipt.onAccount || 0) > 0
                    ? 'receipt-on-account'
                    : 'receipt-applied'
                return (
                  <Fragment key={receipt.id}>
                    <tr className={rowClass} style={receipt.isDeleted ? { opacity: 0.68 } : undefined}>
                      <td className="expand-col">
                        <IconButton
                          size="small"
                          onClick={() => setExpandedReceipts((prev) => ({ ...prev, [receipt.id]: !prev[receipt.id] }))}
                        >
                          {isExpanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
                        </IconButton>
                      </td>
                      <td>
                        <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography fontWeight={800}>{receipt.source} #{receipt.receiptId}</Typography>
                          {receipt.isDeleted ? <Chip size="small" color="error" variant="outlined" label="Deleted" /> : null}
                        </Stack>
                      </td>
                      <td className="date-col">
                        <Typography variant="body2">{receipt.when || '-'}</Typography>
                      </td>
                      <td>
                        {modeChip(receipt.mode)}
                      </td>
                      <td className="amount-col"><MoneyCell value={receipt.cash} /></td>
                      <td className="amount-col"><MoneyCell value={receipt.online} /></td>
                      <td className="amount-col"><MoneyCell value={receipt.total} tone="total" strong /></td>
                      <td className="amount-col"><MoneyCell value={receipt.adjusted} tone="paid" /></td>
                      <td className="amount-col"><MoneyCell value={receipt.onAccount} tone={Number(receipt.onAccount || 0) > 0 ? 'total' : 'paid'} /></td>
                      <td className="allocation-col">
                        <Typography variant="body2" className="clip-text">{receipt.allocation}</Typography>
                      </td>
                      <td align="right">
                        <Stack direction="row" gap={0.5} justifyContent="flex-end" alignItems="center">
                          {receipt.sourceType === 'party_receipt' && receipt.isDeleted ? (
                            <IconButton
                              size="small"
                              color="success"
                              onClick={() => setRecoverReceiptTarget(receipt)}
                              disabled={recoverReceiptM.isPending}
                            >
                              <RestoreIcon fontSize="small" />
                            </IconButton>
                          ) : null}
                          {receipt.sourceType === 'party_receipt' && !receipt.isDeleted ? (
                            <IconButton
                              size="small"
                              color="primary"
                              onClick={() => openEditReceipt(receipt)}
                              disabled={editReceiptM.isPending}
                            >
                              <EditIcon fontSize="small" />
                            </IconButton>
                          ) : null}
                          {receipt.sourceType === 'party_receipt' && !receipt.isDeleted && Number(receipt.onAccount || 0) > 0 ? (
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={() => openApplyAdvance(receipt)}
                              disabled={applyReceiptM.isPending}
                            >
                              Apply
                            </Button>
                          ) : null}
                          {!receipt.isDeleted ? (
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => setDeleteTarget(receipt)}
                              disabled={deleteReceiptM.isPending}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          ) : null}
                        </Stack>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="detail-row">
                        <td colSpan={11}>
                          <Stack gap={1}>
                            <Typography variant="body2" sx={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                              <b>Allocation:</b> {renderBillRefs(receipt.allocation)}
                            </Typography>
                            {receipt.note ? (
                              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                                <b>Note:</b> {receipt.note}
                              </Typography>
                            ) : null}
                            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5} flexWrap="wrap" useFlexGap>
                              <Typography variant="caption">Cash: <b>Rs {money(receipt.cash)}</b></Typography>
                              <Typography variant="caption">Online: <b>Rs {money(receipt.online)}</b></Typography>
                              <Typography variant="caption">Applied: <b>Rs {money(receipt.adjusted)}</b></Typography>
                              <Typography variant="caption">Advance: <b>Rs {money(receipt.onAccount)}</b></Typography>
                              {receipt.isDeleted ? (
                                <Typography variant="caption" color="error">
                                  Deleted at: <b>{receipt.deletedAt || '-'}</b>
                                </Typography>
                              ) : null}
                            </Stack>
                          </Stack>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
              {receiptHistory.length === 0 && (
                <tr>
                  <td colSpan={11}>
                    <Box p={2} color="text.secondary">
                      {selectedParty ? 'No receipts recorded for this customer yet.' : 'Select a customer to view receipts.'}
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={receiptOpen} onClose={() => setReceiptOpen(false)} fullWidth maxWidth="lg">
        <DialogTitle>Record Receipt</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <TextField
                label="Receipt Amount"
                type="number"
                value={receiptAmount}
                onChange={(e) => handleReceiptAmountChange(e.target.value)}
                helperText="Enter full received amount. Apply only what should go against bills."
                fullWidth
              />
              <TextField
                select
                label="Mode"
                value={mode}
                onChange={(e) => setReceiptMode(e.target.value as 'cash' | 'online' | 'split')}
                fullWidth
              >
                <MenuItem value="cash">Cash</MenuItem>
                <MenuItem value="online">Online</MenuItem>
                <MenuItem value="split">Split</MenuItem>
              </TextField>
              {mode === 'split' ? (
                <>
                  <TextField
                    label="Cash"
                    type="number"
                    value={cashAmount}
                    onChange={(e) => setSplitCash(e.target.value)}
                    fullWidth
                  />
                  <TextField
                    label="Online"
                    type="number"
                    value={onlineAmount}
                    onChange={(e) => setSplitOnline(e.target.value)}
                    fullWidth
                  />
                </>
              ) : null}
              <TextField label="Date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
            </Stack>
            <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} multiline minRows={2} fullWidth />

            <Stack direction={{ xs: 'column', md: 'row' }} gap={1} justifyContent="space-between" alignItems={{ md: 'center' }}>
              <Typography variant="h6">Bill Adjustments</Typography>
              <Stack direction="row" gap={1}>
                <Button variant="outlined" onClick={fillAdjustmentsFromReceipt} disabled={receiptTotal <= 0 || openBillsForReceipt.length === 0}>
                  Auto Fill
                </Button>
                <Button variant="outlined" color="inherit" onClick={clearReceiptAdjustments} disabled={openBillsForReceipt.length === 0}>
                  Clear
                </Button>
              </Stack>
            </Stack>
            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Outstanding</th>
                    <th>Remaining Receipt</th>
                    <th>Adjust Now</th>
                  </tr>
                </thead>
                <tbody>
                  {openBillsForReceipt.map((bill) => {
                    const billId = Number(bill.bill_id)
                    const usedElsewhere = Object.entries(adjustmentDrafts).reduce((sum, [id, value]) => {
                      return Number(id) === billId ? sum : sum + Number(value || 0)
                    }, 0)
                    const remainingForThis = Math.max(0, receiptTotal - usedElsewhere)
                    return (
                    <tr key={bill.bill_id}>
                      <td>
                        <Stack gap={0.25}>
                          <Link
                            component="button"
                            underline="hover"
                            onClick={() => openBillDetail(Number(bill.bill_id))}
                            sx={{ fontWeight: 800 }}
                          >
                            Bill #{bill.bill_id}
                          </Link>
                          <Typography variant="caption" color="text.secondary">{bill.bill_date}</Typography>
                        </Stack>
                      </td>
                      <td><Typography fontWeight={800}>Rs {money(bill.outstanding_amount)}</Typography></td>
                      <td>Rs {money(remainingForThis)}</td>
                      <td>
                        <TextField
                          type="number"
                          value={adjustmentDrafts[Number(bill.bill_id)] ?? '0'}
                          onChange={(e) => setDraft(Number(bill.bill_id), e.target.value)}
                          onFocus={() => fillBillAdjustmentOnFocus(bill)}
                          onBlur={() => clampBillAdjustment(bill)}
                          helperText="Focus to fill"
                          sx={{ width: 150 }}
                        />
                      </td>
                    </tr>
                    )
                  })}
                  {openBills.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <Box p={2} color="text.secondary">No open bills to adjust.</Box>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Box>

            <Stack direction={{ xs: 'column', md: 'row' }} gap={3}>
              <Typography>Receipt Total: {money(receiptTotal)}</Typography>
              <Typography>Applied to Bills: {money(adjustmentTotal)}</Typography>
              <Typography fontWeight={700}>Advance / On Account: {money(onAccountAmount)}</Typography>
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReceiptOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveReceipt} disabled={receiptM.isPending || !selectedParty || receiptTotal <= 0 || adjustmentTotal > receiptTotal}>
            Save Receipt
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(applyTarget)} onClose={() => !applyReceiptM.isPending && setApplyTarget(null)} fullWidth maxWidth="lg">
        <DialogTitle>Apply Advance to Bills</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2} justifyContent="space-between">
              <Typography>
                Receipt #{applyTarget?.receiptId || '-'} available: <b>Rs {money(applyAvailable)}</b>
              </Typography>
              <TextField
                label="Apply Date"
                type="date"
                value={applyDate}
                onChange={(e) => setApplyDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                sx={{ minWidth: 180 }}
              />
            </Stack>
            <TextField
              label="Note"
              value={applyNote}
              onChange={(e) => setApplyNote(e.target.value)}
              multiline
              minRows={2}
              fullWidth
            />
            <Stack direction={{ xs: 'column', md: 'row' }} gap={1} justifyContent="space-between" alignItems={{ md: 'center' }}>
              <Typography variant="h6">Bill Adjustments</Typography>
              <Stack direction="row" gap={1}>
                <Button variant="outlined" onClick={fillApplyFromAdvance} disabled={applyAvailable <= 0 || openBillsForReceipt.length === 0}>
                  Auto Fill
                </Button>
                <Button variant="outlined" color="inherit" onClick={clearApplyAdjustments} disabled={openBillsForReceipt.length === 0}>
                  Clear
                </Button>
              </Stack>
            </Stack>
            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Outstanding</th>
                    <th>Remaining Advance</th>
                    <th>Apply Now</th>
                  </tr>
                </thead>
                <tbody>
                  {openBillsForReceipt.map((bill) => {
                    const billId = Number(bill.bill_id)
                    const usedElsewhere = Object.entries(applyDrafts).reduce((sum, [id, value]) => {
                      return Number(id) === billId ? sum : sum + Number(value || 0)
                    }, 0)
                    const remainingForThis = Math.max(0, applyAvailable - usedElsewhere)
                    return (
                      <tr key={bill.bill_id}>
                        <td>
                          <Stack gap={0.25}>
                            <Link
                              component="button"
                              underline="hover"
                              onClick={() => openBillDetail(Number(bill.bill_id))}
                              sx={{ fontWeight: 800 }}
                            >
                              Bill #{bill.bill_id}
                            </Link>
                            <Typography variant="caption" color="text.secondary">{bill.bill_date}</Typography>
                          </Stack>
                        </td>
                        <td><Typography fontWeight={800}>Rs {money(bill.outstanding_amount)}</Typography></td>
                        <td>Rs {money(remainingForThis)}</td>
                        <td>
                          <TextField
                            type="number"
                            value={applyDrafts[Number(bill.bill_id)] ?? '0'}
                            onChange={(e) => setApplyDraft(Number(bill.bill_id), e.target.value)}
                            onFocus={() => fillApplyAdjustmentOnFocus(bill)}
                            onBlur={() => clampApplyAdjustment(bill)}
                            helperText="Focus to fill"
                            sx={{ width: 150 }}
                          />
                        </td>
                      </tr>
                    )
                  })}
                  {openBillsForReceipt.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <Box p={2} color="text.secondary">No open bills to adjust.</Box>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Box>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={3}>
              <Typography>Available Advance: {money(applyAvailable)}</Typography>
              <Typography>Applied to Bills: {money(applyAdjustmentTotal)}</Typography>
              <Typography fontWeight={700}>Remaining Advance: {money(applyRemaining)}</Typography>
            </Stack>
            {applyReceiptM.isError ? (
              <Typography color="error">{(applyReceiptM.error as any)?.response?.data?.detail || (applyReceiptM.error as any)?.message || 'Apply failed'}</Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setApplyTarget(null)} disabled={applyReceiptM.isPending}>Cancel</Button>
          <Button
            variant="contained"
            onClick={saveApplyAdvance}
            disabled={!applyTarget || !selectedParty || !applyDate || applyReceiptM.isPending || applyAdjustmentTotal <= 0 || applyAdjustmentTotal > applyAvailable}
          >
            Apply Advance
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(editReceiptTarget)} onClose={() => !editReceiptM.isPending && setEditReceiptTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Receipt #{editReceiptTarget?.receiptId || ''}</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <TextField
                label="Receipt Amount"
                type="number"
                value={editReceiptAmount}
                onChange={(e) => handleEditReceiptAmountChange(e.target.value)}
                helperText={`Already applied: Rs ${money(editReceiptApplied)}`}
                fullWidth
              />
              <TextField
                select
                label="Mode"
                value={editReceiptMode}
                onChange={(e) => setEditReceiptModeValue(e.target.value as 'cash' | 'online' | 'split')}
                fullWidth
              >
                <MenuItem value="cash">Cash</MenuItem>
                <MenuItem value="online">Online</MenuItem>
                <MenuItem value="split">Split</MenuItem>
              </TextField>
              <TextField
                label="Date"
                type="date"
                value={editReceiptDate}
                onChange={(e) => setEditReceiptDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
            </Stack>
            {editReceiptMode === 'split' ? (
              <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
                <TextField
                  label="Cash"
                  type="number"
                  value={editReceiptCash}
                  onChange={(e) => setEditSplitCash(e.target.value)}
                  fullWidth
                />
                <TextField
                  label="Online"
                  type="number"
                  value={editReceiptOnline}
                  onChange={(e) => setEditSplitOnline(e.target.value)}
                  fullWidth
                />
              </Stack>
            ) : null}
            <TextField
              label="Note"
              value={editReceiptNote}
              onChange={(e) => setEditReceiptNote(e.target.value)}
              multiline
              minRows={2}
              fullWidth
            />
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <Typography>Receipt Total: {money(editReceiptTotal)}</Typography>
              <Typography>Applied to Bills: {money(editReceiptApplied)}</Typography>
              <Typography fontWeight={700}>Advance / On Account: {money(editReceiptAdvance)}</Typography>
            </Stack>
            {editReceiptM.isError ? (
              <Typography color="error">{(editReceiptM.error as any)?.response?.data?.detail || (editReceiptM.error as any)?.message || 'Update failed'}</Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditReceiptTarget(null)} disabled={editReceiptM.isPending}>Cancel</Button>
          <Button
            variant="contained"
            onClick={saveEditReceipt}
            disabled={!editReceiptTarget || !selectedParty || !editReceiptDate || editReceiptM.isPending || editReceiptTotal <= 0 || editReceiptTotal + 0.0001 < editReceiptApplied}
          >
            Save Changes
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(recoverReceiptTarget)} onClose={() => !recoverReceiptM.isPending && setRecoverReceiptTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Recover Receipt</DialogTitle>
        <DialogContent dividers>
          <Stack gap={1}>
            <Typography>
              Customer receipt #{recoverReceiptTarget?.receiptId} for Rs {money(Number(recoverReceiptTarget?.total || 0))}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Linked bill balances and statuses will be recalculated from the recovered receipt.
            </Typography>
            {recoverReceiptM.isError ? (
              <Typography color="error">{(recoverReceiptM.error as any)?.response?.data?.detail || (recoverReceiptM.error as any)?.message || 'Recover failed'}</Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRecoverReceiptTarget(null)} disabled={recoverReceiptM.isPending}>Cancel</Button>
          <Button
            color="success"
            variant="contained"
            onClick={saveRecoverReceipt}
            disabled={!recoverReceiptTarget || !selectedParty || recoverReceiptM.isPending}
          >
            Recover
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onClose={() => !deleteReceiptM.isPending && setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>{deleteTarget?.sourceType === 'party_receipt' ? 'Delete Receipt' : 'Delete Bill Payment'}</DialogTitle>
        <DialogContent dividers>
          <Stack gap={1}>
            <Typography>
              {deleteTarget?.source || 'Receipt'} #{deleteTarget?.receiptId} for Rs {money(Number(deleteTarget?.total || 0))}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Linked bill balances and statuses will be recalculated.
            </Typography>
            {deleteReceiptM.isError ? (
              <Typography color="error">{(deleteReceiptM.error as any)?.message || 'Delete failed'}</Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleteReceiptM.isPending}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => deleteTarget && deleteReceiptM.mutate(deleteTarget)}
            disabled={!deleteTarget || deleteReceiptM.isPending}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

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
                    {(billDetail.items || []).map((it: any, idx: number) => (
                      <tr key={idx}>
                        <td>{it.item_name || it.name || it.item?.name || `#${it.item_id}`}</td>
                        <td>{Number(it.quantity || 0)}</td>
                        <td>{money(it.mrp)}</td>
                        <td>{money(it.line_total)}</td>
                      </tr>
                    ))}
                    {(billDetail.items || []).length === 0 ? (
                      <tr>
                        <td colSpan={4}>
                          <Box p={2} color="text.secondary">
                            No items.
                          </Box>
                        </td>
                      </tr>
                    ) : null}
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
                  Payment Status: <b>{billDetail.payment_status || '-'}</b>
                </Typography>
                <Typography>
                  Paid Amount: <b>{money(billDetail.paid_amount || 0)}</b>
                </Typography>
                <Typography>
                  Write-off Amount: <b>{money(billDetail.writeoff_amount || 0)}</b>
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
                {!billDetail.is_deleted ? (
                  <Box sx={{ pt: 1 }}>
                    <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => setBillEditOpen(true)}>
                      Edit Bill
                    </Button>
                  </Box>
                ) : null}
              </Stack>

              <Divider />
              <BillPaymentsPanel
                bill={billDetail}
                onBillUpdated={async (updatedBill) => {
                  setBillDetail(updatedBill)
                  refreshLedgerQueries()
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
          refreshLedgerQueries()
        }}
      />
    </Stack>
    )
  }

  function statusChip(status: string) {
    const normalized = String(status || 'UNPAID').toUpperCase()
    const sx =
      normalized === 'PAID'
        ? { bgcolor: 'success.main', color: '#fff' }
        : normalized === 'PARTIAL'
          ? { bgcolor: 'warning.main', color: '#fff' }
          : { bgcolor: 'error.main', color: '#fff' }
    return <Chip size="small" label={normalized} sx={{ ...sx, fontWeight: 800 }} />
  }

  function modeChip(receiptMode: string) {
    const normalized = String(receiptMode || '').toUpperCase()
    const color = normalized === 'CASH' ? 'success' : normalized === 'ONLINE' ? 'primary' : 'secondary'
    return <Chip size="small" color={color as any} variant="outlined" label={normalized || '-'} sx={{ fontWeight: 800 }} />
  }
