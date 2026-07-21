import { useMemo, useState } from 'react'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useToast } from '../../components/ui/Toaster'
import type { Customer, Ledger, PostedVoucher } from '../../lib/types'
import {
  createJournalVoucher,
  convertSuspenseReceiptToSale,
  fetchSuspenseStockAvailability,
  fetchSuspenseStatement,
  listLedgers,
  updateJournalVoucher,
  type JournalVoucherPayload,
  type DatedStock,
  type SuspenseBookEntry,
} from '../../services/vouchers'
import { createCashbookEntry, updateCashbookEntry, type CashbookType } from '../../services/cashbook'
import { createBankbookEntry, updateBankbookEntry, type BankbookMode, type BankbookType } from '../../services/bankbook'
import { fetchCustomers } from '../../services/customers'

type EntryType = 'DR' | 'CR'
type EditSource = 'JOURNAL' | 'CASHBOOK' | 'BANKBOOK'

function ymd(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function money(value: number | string | null | undefined) {
  return Number(value || 0).toFixed(2)
}

function roundMoney(value: number) {
  return Number(Number(value || 0).toFixed(2))
}

function balanceLabel(value: number) {
  if (Math.abs(value) < 0.005) return '0.00'
  return `${money(Math.abs(value))} ${value > 0 ? 'Dr' : 'Cr'}`
}

function balanceColor(value: number) {
  if (value > 0.004) return 'success.dark'
  if (value < -0.004) return 'error.dark'
  return 'text.primary'
}

function sourceChip(source: EditSource) {
  if (source === 'CASHBOOK') return { label: 'Cash', sx: { bgcolor: '#fff3cd', color: '#7a4b00', borderColor: '#e0b84f' } }
  if (source === 'BANKBOOK') return { label: 'Bank', sx: { bgcolor: '#dbeafe', color: '#174ea6', borderColor: '#82aef5' } }
  return { label: 'Journal', sx: { bgcolor: '#ede9fe', color: '#5b21b6', borderColor: '#b8a6ee' } }
}

export default function SuspenseAccountPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const today = useMemo(() => new Date(), [])
  const [fromDate, setFromDate] = useState(ymd(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [toDate, setToDate] = useState(ymd(today))
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editSource, setEditSource] = useState<EditSource>('CASHBOOK')
  const [entryDate, setEntryDate] = useState(ymd(today))
  const [voucherNo, setVoucherNo] = useState('')
  const [entryType, setEntryType] = useState<EntryType>('DR')
  const [amount, setAmount] = useState('')
  const [counterpart, setCounterpart] = useState<Ledger | null>(null)
  const [narration, setNarration] = useState('')
  const [bookEntryType, setBookEntryType] = useState<'RECEIPT' | 'WITHDRAWAL' | 'EXPENSE'>('EXPENSE')
  const [bankMode, setBankMode] = useState<BankbookMode>('UPI')
  const [txnCharges, setTxnCharges] = useState('0')
  const [saleOpen, setSaleOpen] = useState(false)
  const [saleCustomer, setSaleCustomer] = useState<Customer | null>(null)
  const [saleLines, setSaleLines] = useState<Array<{ categoryId: string; productKey: string; item: DatedStock | null; quantity: string; unitPrice: string; discountPercent: string }>>([
    { categoryId: '', productKey: '', item: null, quantity: '1', unitPrice: '', discountPercent: '0' },
  ])

  const statementQ = useQuery({
    queryKey: ['suspense-statement', fromDate, toDate],
    queryFn: () => fetchSuspenseStatement({ from_date: fromDate, to_date: toDate }),
    enabled: Boolean(fromDate && toDate),
  })
  const ledgersQ = useQuery({
    queryKey: ['suspense-counterpart-ledgers'],
    queryFn: () => listLedgers(),
    staleTime: 60_000,
  })
  const saleItemsQ = useQuery({
    queryKey: ['suspense-sale-items', entryDate],
    queryFn: () => fetchSuspenseStockAvailability(entryDate),
    enabled: saleOpen && Boolean(entryDate),
  })
  const saleCustomersQ = useQuery({
    queryKey: ['suspense-sale-customers'],
    queryFn: () => fetchCustomers({ limit: 1000 }),
    enabled: saleOpen,
  })
  const datedSaleItems = saleItemsQ.data || []
  const saleCategories = useMemo(() => {
    const values = new Map<string, string>()
    for (const item of datedSaleItems) {
      const key = item.category_id ? String(item.category_id) : 'uncategorized'
      values.set(key, item.category_name || 'Uncategorized')
    }
    return [...values.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [datedSaleItems])

  const suspense = statementQ.data?.ledger
  const counterpartOptions = useMemo(
    () => (ledgersQ.data || []).filter((ledger) => ledger.is_active && Number(ledger.id) !== Number(suspense?.id)),
    [ledgersQ.data, suspense?.id],
  )

  const rows = useMemo(() => {
    let balance = Number(statementQ.data?.opening_balance || 0)
    const journalRows = (statementQ.data?.vouchers || []).map((voucher) => {
      const suspenseEntries = voucher.entries.filter((entry) => Number(entry.ledger_id) === Number(suspense?.id))
      const debit = suspenseEntries
        .filter((entry) => entry.entry_type === 'DR')
        .reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
      const credit = suspenseEntries
        .filter((entry) => entry.entry_type === 'CR')
        .reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
      const otherEntries = voucher.entries.filter((entry) => Number(entry.ledger_id) !== Number(suspense?.id))
      const editable = voucher.source_type === 'MANUAL_JOURNAL' && suspenseEntries.length === 1 && otherEntries.length === 1
      return {
        key: `JOURNAL-${voucher.id}`,
        date: voucher.voucher_date,
        sortTs: `${voucher.voucher_date}T00:00:00`,
        source: 'JOURNAL' as EditSource,
        sourceId: Number(voucher.id),
        reference: voucher.voucher_no,
        particulars: otherEntries.map((entry) => entry.ledger_name || `Ledger #${entry.ledger_id}`).join(', ') || '-',
        note: voucher.narration || '',
        debit,
        credit,
        editable,
        voucher,
        bookEntry: null as SuspenseBookEntry | null,
      }
    })
    const bookRows = (statementQ.data?.book_entries || []).map((entry) => {
      const isReceipt = entry.entry_type === 'RECEIPT'
      return {
        key: `${entry.source_type}-${entry.source_id}`,
        date: entry.created_at.slice(0, 10),
        sortTs: entry.created_at,
        source: entry.source_type as EditSource,
        sourceId: entry.source_id,
        reference: `${entry.source_type === 'CASHBOOK' ? 'Cash' : 'Bank'} #${entry.source_id}`,
        particulars: `${entry.source_type === 'CASHBOOK' ? 'Cashbook' : 'Bank Book'} · ${entry.entry_type}${entry.mode ? ` · ${entry.mode}` : ''}`,
        note: entry.note || '',
        debit: isReceipt ? 0 : Number(entry.amount || 0),
        credit: isReceipt ? Number(entry.amount || 0) : 0,
        editable: true,
        voucher: null as PostedVoucher | null,
        bookEntry: entry,
      }
    })
    return [...journalRows, ...bookRows]
      .sort((a, b) => a.sortTs.localeCompare(b.sortTs) || a.key.localeCompare(b.key))
      .map((row) => {
        balance += row.debit - row.credit
        return { ...row, balance }
      })
  }, [statementQ.data, suspense?.id])

  function resetDialog() {
    setDialogOpen(false)
    setEditingId(null)
    setEditSource('CASHBOOK')
    setEntryDate(ymd(new Date()))
    setVoucherNo('')
    setEntryType('DR')
    setAmount('')
    setCounterpart(null)
    setNarration('')
    setBookEntryType('EXPENSE')
    setBankMode('UPI')
    setTxnCharges('0')
  }

  function openNew() {
    resetDialog()
    setEditSource('CASHBOOK')
    setDialogOpen(true)
  }

  function openEdit(voucher: PostedVoucher) {
    if (!suspense) return
    const suspenseEntry = voucher.entries.find((entry) => Number(entry.ledger_id) === Number(suspense.id))
    const otherEntry = voucher.entries.find((entry) => Number(entry.ledger_id) !== Number(suspense.id))
    if (!suspenseEntry || !otherEntry) return
    const knownLedger = (ledgersQ.data || []).find((ledger) => Number(ledger.id) === Number(otherEntry.ledger_id))
    setEditingId(Number(voucher.id))
    setEditSource('JOURNAL')
    setEntryDate(voucher.voucher_date)
    setVoucherNo(voucher.voucher_no || '')
    setEntryType(suspenseEntry.entry_type)
    setAmount(String(suspenseEntry.amount || ''))
    setCounterpart(knownLedger || {
      id: otherEntry.ledger_id,
      name: otherEntry.ledger_name || `Ledger #${otherEntry.ledger_id}`,
      group_id: 0,
      party_id: null,
      system_key: null,
      is_system: false,
      is_active: true,
      created_at: '',
      updated_at: '',
    })
    setNarration(voucher.narration || '')
    setDialogOpen(true)
  }

  function openBookEdit(entry: SuspenseBookEntry) {
    setEditingId(entry.source_id)
    setEditSource(entry.source_type)
    setEntryDate(entry.created_at.slice(0, 10))
    setVoucherNo('')
    setBookEntryType(entry.entry_type)
    setAmount(String(entry.amount || ''))
    setBankMode((entry.mode || 'UPI') as BankbookMode)
    setTxnCharges(String(entry.txn_charges || 0))
    setNarration(entry.note || '')
    setCounterpart(null)
    setDialogOpen(true)
  }

  const saveM = useMutation({
    mutationFn: async () => {
      const numericAmount = Number(amount || 0)
      if (numericAmount <= 0) throw new Error('Enter an amount greater than zero')
      if (editSource === 'CASHBOOK') {
        const payload = {
          entry_type: bookEntryType as CashbookType,
          amount: numericAmount,
          note: narration.trim() || undefined,
          entry_date: entryDate,
          is_suspense: true,
        }
        return editingId ? updateCashbookEntry(editingId, payload) : createCashbookEntry(payload)
      }
      if (editSource === 'BANKBOOK') {
        const payload = {
          entry_type: bookEntryType as BankbookType,
          mode: bankMode,
          amount: numericAmount,
          txn_charges: Number(txnCharges || 0),
          note: narration.trim() || undefined,
          entry_date: entryDate,
          is_suspense: true,
        }
        return editingId ? updateBankbookEntry(editingId, payload) : createBankbookEntry(payload)
      }
      if (!suspense || !counterpart || numericAmount <= 0) throw new Error('Select a counterpart ledger and enter an amount')
      const payload: JournalVoucherPayload = {
        voucher_date: entryDate,
        voucher_no: voucherNo.trim() || undefined,
        narration: narration.trim() || undefined,
        entries: [
          {
            ledger_id: Number(suspense.id),
            entry_type: entryType,
            amount: numericAmount,
            narration: narration.trim() || undefined,
          },
          {
            ledger_id: Number(counterpart.id),
            entry_type: entryType === 'DR' ? 'CR' : 'DR',
            amount: numericAmount,
            narration: narration.trim() || undefined,
          },
        ],
      }
      return editingId ? updateJournalVoucher(editingId, payload) : createJournalVoucher(payload)
    },
    onSuccess: () => {
      toast.push(editingId ? 'Suspense entry updated' : 'Suspense entry added', 'success')
      resetDialog()
      queryClient.invalidateQueries({ queryKey: ['suspense-statement'] })
      queryClient.invalidateQueries({ queryKey: ['journal-vouchers'] })
      queryClient.invalidateQueries({ queryKey: ['voucher-day-book'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook'] })
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Could not save suspense entry'), 'error'),
  })

  const saleTotal = saleLines.reduce(
    (sum, line) => roundMoney(sum + roundMoney(Number(line.quantity || 0) * Number(line.unitPrice || 0) * (1 - Number(line.discountPercent || 0) / 100))),
    0,
  )
  const convertSaleM = useMutation({
    mutationFn: () => {
      if (!editingId || !['CASHBOOK', 'BANKBOOK'].includes(editSource)) throw new Error('Suspense receipt is missing')
      if (saleLines.some((line) => !line.item || Number(line.quantity || 0) <= 0 || Number(line.quantity || 0) > Number(line.item?.available || 0) || Number(line.unitPrice || 0) < 0 || Number(line.discountPercent || 0) < 0 || Number(line.discountPercent || 0) > 100)) {
        throw new Error('Select every product and enter a valid quantity and selling price')
      }
      return convertSuspenseReceiptToSale(editSource as 'CASHBOOK' | 'BANKBOOK', editingId, {
        bill_date: entryDate,
        customer_id: saleCustomer?.id ? Number(saleCustomer.id) : undefined,
        notes: narration.trim() || undefined,
        items: saleLines.map((line) => ({
          item_id: Number(line.item?.item_id),
          quantity: Number(line.quantity),
          unit_price: Number(line.unitPrice),
          discount_percent: Number(line.discountPercent || 0),
        })),
      })
    },
    onSuccess: (result) => {
      toast.push(`Bill #${result.bill_number} created`, 'success')
      setSaleOpen(false)
      resetDialog()
      queryClient.invalidateQueries({ queryKey: ['suspense-statement'] })
      queryClient.invalidateQueries({ queryKey: ['bills'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['voucher-day-book'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook'] })
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Could not convert suspense receipt'), 'error'),
  })

  function openSaleConversion() {
    setSaleLines([{ categoryId: '', productKey: '', item: null, quantity: '1', unitPrice: '', discountPercent: '0' }])
    setSaleCustomer(null)
    setDialogOpen(false)
    setSaleOpen(true)
  }

  return (
    <Stack gap={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} gap={1}>
        <Box>
          <Typography variant="h5">Suspense Account</Typography>
          <Typography color="text.secondary" variant="body2">Direct Cashbook, Bank Book, and suspense adjustment entries</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openNew}>Add Entry</Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.25} alignItems={{ sm: 'center' }}>
          <TextField label="From" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField label="To" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} InputLabelProps={{ shrink: true }} />
          <Box sx={{ flex: 1 }} />
          <Typography color={balanceColor(Number(statementQ.data?.opening_balance || 0))} fontWeight={700}>
            Opening: {balanceLabel(Number(statementQ.data?.opening_balance || 0))}
          </Typography>
          <Typography color={balanceColor(Number(statementQ.data?.closing_balance || 0))} fontWeight={700}>
            Closing: {balanceLabel(Number(statementQ.data?.closing_balance || 0))}
          </Typography>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Source</th>
                <th>Voucher</th>
                <th>Particulars</th>
                <th>Debit</th>
                <th>Credit</th>
                <th>Balance</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{fromDate}</td>
                <td><Chip size="small" label="Opening" variant="outlined" /></td>
                <td>-</td>
                <td><strong>Opening balance</strong></td>
                <td>-</td>
                <td>-</td>
                <td style={{ color: balanceColor(Number(statementQ.data?.opening_balance || 0)) === 'success.dark' ? '#1b5e20' : balanceColor(Number(statementQ.data?.opening_balance || 0)) === 'error.dark' ? '#b71c1c' : undefined, fontWeight: 700 }}>
                  {balanceLabel(Number(statementQ.data?.opening_balance || 0))}
                </td>
                <td>-</td>
              </tr>
              {rows.map((row) => {
                const source = sourceChip(row.source)
                const isPositive = row.debit > 0
                return (
                <tr key={row.key} style={{ backgroundColor: isPositive ? '#f0fdf4' : '#fff5f5' }}>
                  <td>{row.date}</td>
                  <td><Chip size="small" label={source.label} variant="outlined" sx={{ ...source.sx, fontWeight: 700 }} /></td>
                  <td>{row.reference}</td>
                  <td style={{ minWidth: 240 }}>
                    <strong>{row.particulars}</strong>
                    {row.note ? <Box color="text.secondary">{row.note}</Box> : null}
                  </td>
                  <td style={{ color: '#1b5e20', fontWeight: row.debit ? 800 : 400 }}>{row.debit ? `+${money(row.debit)}` : '-'}</td>
                  <td style={{ color: '#b71c1c', fontWeight: row.credit ? 800 : 400 }}>{row.credit ? `-${money(row.credit)}` : '-'}</td>
                  <td style={{ color: row.balance > 0.004 ? '#1b5e20' : row.balance < -0.004 ? '#b71c1c' : undefined, fontWeight: 700 }}>{balanceLabel(row.balance)}</td>
                  <td>
                    <Tooltip title={row.editable ? 'Edit entry' : 'Only two-line manual journal entries can be edited here'}>
                      <span>
                        <IconButton
                          size="small"
                          disabled={!row.editable}
                          onClick={() => row.bookEntry ? openBookEdit(row.bookEntry) : row.voucher && openEdit(row.voucher)}
                        >
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </td>
                </tr>
              )})}
              {rows.length === 0 && (
                <tr><td colSpan={8}><Box p={2} color="text.secondary">{statementQ.isLoading ? 'Loading...' : 'No suspense entries in this date range.'}</Box></td></tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={dialogOpen} onClose={resetDialog} fullWidth maxWidth="sm">
        <DialogTitle>{editingId ? `Edit ${editSource === 'CASHBOOK' ? 'Cashbook' : editSource === 'BANKBOOK' ? 'Bank Book' : 'Suspense'} Entry` : 'Add Suspense Entry'}</DialogTitle>
        <DialogContent>
          <Stack gap={2} sx={{ pt: 1 }}>
            {!editingId ? (
              <TextField
                select
                label="Cash or Bank"
                value={editSource}
                onChange={(event) => setEditSource(event.target.value as 'CASHBOOK' | 'BANKBOOK')}
                helperText="Choose where the money was received or paid."
                fullWidth
              >
                <MenuItem value="CASHBOOK">Cash</MenuItem>
                <MenuItem value="BANKBOOK">Bank</MenuItem>
              </TextField>
            ) : null}
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.25}>
              <TextField label="Date" type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
              {editSource === 'JOURNAL' ? (
                <TextField label="Voucher No. (optional)" value={voucherNo} onChange={(event) => setVoucherNo(event.target.value)} fullWidth />
              ) : null}
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.25}>
              {editSource === 'JOURNAL' ? (
                <TextField select label="Suspense side" value={entryType} onChange={(event) => setEntryType(event.target.value as EntryType)} fullWidth>
                  <MenuItem value="DR">Debit</MenuItem>
                  <MenuItem value="CR">Credit</MenuItem>
                </TextField>
              ) : (
                <TextField select label="Entry type" value={bookEntryType} onChange={(event) => setBookEntryType(event.target.value as typeof bookEntryType)} fullWidth>
                  <MenuItem value="RECEIPT">Receipt</MenuItem>
                  <MenuItem value="WITHDRAWAL">Withdrawal</MenuItem>
                  <MenuItem value="EXPENSE">Expense</MenuItem>
                </TextField>
              )}
              <TextField label="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} inputProps={{ min: 0, step: '0.01' }} fullWidth />
            </Stack>
            {editSource !== 'JOURNAL' ? (
              <Typography variant="caption" color="text.secondary">
                Receipt: Cash/Bank Dr, Suspense Cr. Withdrawal or Expense: Suspense Dr, Cash/Bank Cr.
              </Typography>
            ) : null}
            {editSource === 'JOURNAL' ? (
              <Autocomplete
                options={counterpartOptions}
                value={counterpart}
                onChange={(_event, value) => setCounterpart(value)}
                getOptionLabel={(option) => option.name}
                isOptionEqualToValue={(option, value) => Number(option.id) === Number(value.id)}
                renderInput={(params) => <TextField {...params} label="Counterpart ledger" placeholder="Cash, supplier, expense…" />}
              />
            ) : null}
            {editSource === 'BANKBOOK' ? (
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.25}>
                <TextField select label="Bank mode" value={bankMode} onChange={(event) => setBankMode(event.target.value as BankbookMode)} fullWidth>
                  {['UPI', 'NEFT', 'RTGS', 'IMPS', 'BANK_DEPOSIT'].map((mode) => <MenuItem key={mode} value={mode}>{mode}</MenuItem>)}
                </TextField>
                <TextField label="Transaction charges" type="number" value={txnCharges} onChange={(event) => setTxnCharges(event.target.value)} inputProps={{ min: 0, step: '0.01' }} fullWidth />
              </Stack>
            ) : null}
            <TextField label="Particulars / Notes" value={narration} onChange={(event) => setNarration(event.target.value)} multiline minRows={2} />
          </Stack>
        </DialogContent>
        <DialogActions>
          {editingId && editSource !== 'JOURNAL' && bookEntryType === 'RECEIPT' ? (
            <Button color="secondary" onClick={openSaleConversion}>Convert to Sale</Button>
          ) : null}
          <Button onClick={resetDialog}>Cancel</Button>
          <Button variant="contained" onClick={() => saveM.mutate()} disabled={saveM.isPending}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={saleOpen} onClose={() => !convertSaleM.isPending && setSaleOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Convert Suspense Receipt to Sale</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ pt: 1 }}>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1}>
                <Typography><strong>{editSource === 'CASHBOOK' ? 'Cash' : 'Bank'} receipt:</strong> ₹{money(amount)}</Typography>
                <Typography><strong>Bill date:</strong> {entryDate}</Typography>
              </Stack>
            </Paper>
            <Autocomplete
              options={saleCustomersQ.data || []}
              value={saleCustomer}
              onChange={(_event, value) => setSaleCustomer(value)}
              getOptionLabel={(option) => [option.name, option.phone].filter(Boolean).join(' · ')}
              isOptionEqualToValue={(a, b) => Number(a.id) === Number(b.id)}
              renderInput={(params) => <TextField {...params} label="Customer (optional)" />}
            />
            {saleLines.map((line, index) => {
              const categoryItems = datedSaleItems.filter((item) => (item.category_id ? String(item.category_id) : 'uncategorized') === line.categoryId)
              const products = [...new Map(categoryItems.map((item) => {
                const key = `${item.product_id || 0}|${item.name}|${item.brand || ''}`
                return [key, { key, label: `${item.name}${item.brand ? ` · ${item.brand}` : ''}` }]
              })).values()]
              const batchOptions = categoryItems.filter((item) => `${item.product_id || 0}|${item.name}|${item.brand || ''}` === line.productKey)
              const gross = Number(line.quantity || 0) * Number(line.unitPrice || 0)
              const discount = gross * Number(line.discountPercent || 0) / 100
              return (
              <Paper key={index} variant="outlined" sx={{ p: 1.25 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} gap={1} alignItems={{ md: 'center' }} flexWrap="wrap">
                <TextField
                  select
                  label="Category"
                  value={line.categoryId}
                  onChange={(event) => setSaleLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, categoryId: event.target.value, productKey: '', item: null } : row))}
                  sx={{ flex: '1 1 170px' }}
                >
                  {saleCategories.map((category) => <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>)}
                </TextField>
                <TextField
                  select
                  label="Product"
                  value={line.productKey}
                  disabled={!line.categoryId}
                  onChange={(event) => setSaleLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, productKey: event.target.value, item: null } : row))}
                  sx={{ flex: '1.4 1 220px' }}
                >
                  {products.map((product) => <MenuItem key={product.key} value={product.key}>{product.label}</MenuItem>)}
                </TextField>
                <Autocomplete
                  sx={{ flex: '1.6 1 260px', minWidth: 0 }}
                  options={batchOptions}
                  value={line.item}
                  onChange={(_event, value) => setSaleLines((current) => current.map((row, rowIndex) => rowIndex === index ? {
                    ...row,
                    item: value,
                    unitPrice: value ? String(value.mrp || 0) : '',
                  } : row))}
                  getOptionLabel={(option) => `Batch #${option.item_id} · Exp ${option.expiry_date || '-'} · MRP ${money(option.mrp)} · Available ${option.available}`}
                  isOptionEqualToValue={(a, b) => Number(a.item_id) === Number(b.item_id)}
                  renderInput={(params) => <TextField {...params} label="Batch / dated availability" />}
                />
                <TextField
                  sx={{ flex: 0.55 }}
                  label="Qty"
                  type="number"
                  value={line.quantity}
                  onChange={(event) => setSaleLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, quantity: event.target.value } : row))}
                  inputProps={{ min: 1, max: line.item?.available || undefined, step: 1 }}
                />
                <TextField
                  sx={{ flex: 0.7 }}
                  label="Selling Price"
                  type="number"
                  value={line.unitPrice}
                  onChange={(event) => setSaleLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, unitPrice: event.target.value } : row))}
                  inputProps={{ min: 0, step: 0.01 }}
                />
                <TextField
                  sx={{ flex: '0.6 1 115px' }}
                  label="Discount %"
                  type="number"
                  value={line.discountPercent}
                  onChange={(event) => setSaleLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, discountPercent: event.target.value } : row))}
                  inputProps={{ min: 0, max: 100, step: 0.01 }}
                />
                <Typography sx={{ minWidth: 105, textAlign: 'right', fontWeight: 800 }}>
                  ₹{money(gross - discount)}
                </Typography>
                <IconButton
                  color="error"
                  disabled={saleLines.length === 1}
                  onClick={() => setSaleLines((current) => current.filter((_row, rowIndex) => rowIndex !== index))}
                >
                  <DeleteOutlineIcon />
                </IconButton>
              </Stack>
              <Typography variant="caption" color="text.secondary">Gross ₹{money(gross)} · Discount ₹{money(discount)} · Net ₹{money(gross - discount)}</Typography>
              </Paper>
            )})}
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setSaleLines((current) => [...current, { categoryId: '', productKey: '', item: null, quantity: '1', unitPrice: '', discountPercent: '0' }])}>
              Add Product
            </Button>
            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: Math.abs(saleTotal - Number(amount || 0)) < 0.01 ? 'rgba(20,92,59,0.06)' : 'rgba(211,47,47,0.06)' }}>
              <Stack direction="row" justifyContent="space-between">
                <Typography fontWeight={800}>Sale Total</Typography>
                <Typography fontWeight={900}>₹{money(saleTotal)} / Receipt ₹{money(amount)}</Typography>
              </Stack>
              {Math.abs(saleTotal - Number(amount || 0)) >= 0.01 ? (
                <Typography variant="caption" color="error">Product total must equal the suspense receipt exactly.</Typography>
              ) : null}
            </Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaleOpen(false)} disabled={convertSaleM.isPending}>Cancel</Button>
          <Button variant="contained" onClick={() => convertSaleM.mutate()} disabled={convertSaleM.isPending || Math.abs(saleTotal - Number(amount || 0)) >= 0.01}>
            {convertSaleM.isPending ? 'Creating Bill…' : 'Create Backdated Bill'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
