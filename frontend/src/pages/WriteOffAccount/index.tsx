import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { fetchWriteOffStatement } from '../../services/vouchers'
import { editBillPayment, undoBillPayment } from '../../services/billing'
import { deletePurchasePayment, updatePurchasePayment } from '../../services/purchases'
import { useToast } from '../../components/ui/Toaster'

function ymd(date: Date) {
  return date.toISOString().slice(0, 10)
}

function money(value: number | string | null | undefined) {
  return Number(value || 0).toFixed(2)
}

export default function WriteOffAccountPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const queryClient = useQueryClient()
  const today = useMemo(() => new Date(), [])
  const [fromDate, setFromDate] = useState(params.get('from') || ymd(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [toDate, setToDate] = useState(params.get('to') || ymd(today))
  const [accountType, setAccountType] = useState<'all' | 'customer' | 'supplier'>(params.get('account') === 'customer' || params.get('account') === 'supplier' ? params.get('account') as 'customer' | 'supplier' : 'all')
  const [query, setQuery] = useState(params.get('q') || '')
  const [editRow, setEditRow] = useState<any | null>(null)
  const [editAmount, setEditAmount] = useState('')
  const [editDate, setEditDate] = useState('')
  const [editNote, setEditNote] = useState('')
  const [saving, setSaving] = useState(false)

  const statementQ = useQuery({
    queryKey: ['writeoff-account', fromDate, toDate, accountType, query],
    queryFn: () => fetchWriteOffStatement({
      from_date: fromDate || undefined,
      to_date: toDate || undefined,
      account_type: accountType,
      q: query.trim() || undefined,
    }),
  })
  const statement = statementQ.data
  const ledgerIds = {
    customer: Number(statement?.customer_ledger.id || 0),
    supplier: Number(statement?.supplier_ledger.id || 0),
  }
  const rows = (statement?.vouchers || []).flatMap((voucher) =>
    voucher.entries
      .filter((entry) => [ledgerIds.customer, ledgerIds.supplier].includes(Number(entry.ledger_id)))
      .map((entry) => {
        const customer = Number(entry.ledger_id) === ledgerIds.customer
        const reversal = customer ? entry.entry_type === 'CR' : entry.entry_type === 'DR'
        const counterparty = voucher.entries.find((candidate) => Number(candidate.ledger_id) !== Number(entry.ledger_id))
        const transaction = statement?.transactions.find((candidate) => Number(candidate.voucher_id) === Number(voucher.id))
        return { voucher, entry, customer, reversal, counterparty, transaction }
      }),
  )

  useEffect(() => {
    const next = new URLSearchParams(params)
    next.set('from', fromDate)
    next.set('to', toDate)
    accountType === 'all' ? next.delete('account') : next.set('account', accountType)
    query ? next.set('q', query) : next.delete('q')
    if (next.toString() !== params.toString()) setParams(next, { replace: true })
  }, [accountType, fromDate, params, query, setParams, toDate])

  useEffect(() => {
    const voucherId = Number(params.get('focus') || 0)
    if (!voucherId || !rows.some((row) => Number(row.voucher.id) === voucherId)) return
    window.requestAnimationFrame(() => document.getElementById(`writeoff-voucher-${voucherId}`)?.scrollIntoView({ block: 'center' }))
  }, [params, rows])

  function viewLedger(row: any) {
    const partyId = Number(row.transaction?.party_id || 0)
    const paymentId = Number(row.transaction?.payment_id || 0)
    const documentId = Number(row.transaction?.document_id || 0)
    const returnParams = new URLSearchParams(params)
    returnParams.set('focus', String(row.voucher.id))
    const returnTo = `${location.pathname}?${returnParams.toString()}`
    setParams(returnParams, { replace: true })
    const target = new URLSearchParams()
    if (row.customer) {
      if (partyId) target.set('party_id', String(partyId))
      if (paymentId) target.set('payment_id', String(paymentId))
      if (documentId) target.set('bill_id', String(documentId))
      target.set('return_to', returnTo)
      navigate(`/customer-ledger?${target.toString()}`)
    } else {
      if (partyId) target.set('supplier_id', String(partyId))
      if (paymentId) target.set('payment_id', String(paymentId))
      if (documentId) target.set('purchase_id', String(documentId))
      target.set('return_to', returnTo)
      navigate(`/supplier-ledger?${target.toString()}`)
    }
  }

  function beginEdit(row: any) {
    setEditRow(row)
    setEditAmount(String(Number(row.entry.amount || 0)))
    setEditDate(row.voucher.voucher_date)
    setEditNote(row.entry.narration || row.voucher.narration || '')
  }

  async function saveEdit() {
    if (!editRow?.transaction?.can_edit || Number(editAmount) <= 0) return
    setSaving(true)
    try {
      const tx = editRow.transaction
      if (editRow.customer) {
        await editBillPayment(Number(tx.document_id), Number(tx.payment_id), {
          mode: 'cash', cash_amount: 0, online_amount: 0, is_writeoff: true,
          writeoff_amount: Number(editAmount), payment_date: editDate, note: editNote.trim() || undefined,
        })
      } else {
        await updatePurchasePayment(Number(tx.document_id), Number(tx.payment_id), {
          mode: 'writeoff', amount: Number(editAmount), cash_amount: 0, online_amount: 0,
          is_writeoff: true, paid_at: editDate, note: editNote.trim() || undefined,
        })
      }
      setEditRow(null)
      await queryClient.invalidateQueries()
      toast.push('Write-off updated', 'success')
    } catch (error: any) {
      toast.push(String(error?.response?.data?.detail || error?.message || 'Write-off update failed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function deleteRow(row: any) {
    const tx = row.transaction
    if (!tx?.can_delete || !window.confirm(`Delete write-off voucher ${row.voucher.voucher_no}? The source balance will be recalculated.`)) return
    setSaving(true)
    try {
      if (row.customer) await undoBillPayment(Number(tx.document_id), Number(tx.payment_id))
      else await deletePurchasePayment(Number(tx.document_id), Number(tx.payment_id))
      await queryClient.invalidateQueries()
      toast.push('Write-off deleted and balance recalculated', 'success')
    } catch (error: any) {
      toast.push(String(error?.response?.data?.detail || error?.message || 'Write-off delete failed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack gap={2}>
      <Box>
        <Typography variant="h5">Write-Off Account</Typography>
        <Typography color="text.secondary">
          Customer bad debts are expenses; supplier balance write-offs are income.
        </Typography>
      </Box>

      <Paper sx={{ p: 2 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, 1fr)' }, gap: 1.25 }}>
          <TextField label="From" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField label="To" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField select label="Account" value={accountType} onChange={(e) => setAccountType(e.target.value as typeof accountType)}>
            <MenuItem value="all">All Write-offs</MenuItem>
            <MenuItem value="customer">Customer Write-offs</MenuItem>
            <MenuItem value="supplier">Supplier Write-offs</MenuItem>
          </TextField>
          <TextField label="Search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Voucher or note" />
        </Box>
      </Paper>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 1.5 }}>
        <Paper sx={{ p: 2 }}><Typography color="text.secondary">Customer Write-off Expense</Typography><Typography variant="h5">₹{money(statement?.customer_writeoff_expense)}</Typography></Paper>
        <Paper sx={{ p: 2 }}><Typography color="text.secondary">Supplier Write-off Income</Typography><Typography variant="h5">₹{money(statement?.supplier_writeoff_income)}</Typography></Paper>
        <Paper sx={{ p: 2 }}><Typography color="text.secondary">Net Write-off Expense</Typography><Typography variant="h5">₹{money(statement?.net_expense)}</Typography></Paper>
      </Box>

      <Paper sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Date</th><th>Account</th><th>Voucher</th><th>Counterparty</th><th>DR/CR</th><th>Amount</th><th>Effect</th><th>Narration</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const { voucher, entry, customer, reversal, counterparty, transaction } = row
                return (
                <tr id={`writeoff-voucher-${voucher.id}`} key={`${voucher.id}-${entry.id}`}>
                  <td>{voucher.voucher_date}</td>
                  <td><Chip size="small" color={customer ? 'error' : 'success'} label={customer ? 'Customer Expense' : 'Supplier Income'} /></td>
                  <td>{voucher.voucher_no}</td>
                  <td>{counterparty?.ledger_name || '-'}</td>
                  <td>{entry.entry_type}</td>
                  <td>₹{money(entry.amount)}</td>
                  <td>{reversal ? 'Reversal' : 'Write-off'}</td>
                  <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{entry.narration || voucher.narration || '-'}</td>
                  <td><Stack direction="row" gap={0.5}><Button size="small" onClick={() => viewLedger(row)}>View</Button>{transaction?.can_edit && !reversal ? <Button size="small" onClick={() => beginEdit(row)}>Edit</Button> : null}{transaction?.can_delete && !reversal ? <Button size="small" color="error" disabled={saving} onClick={() => deleteRow(row)}>Delete</Button> : null}</Stack></td>
                </tr>
              )})}
              {rows.length === 0 && <tr><td colSpan={9}><Box p={2} color="text.secondary">{statementQ.isLoading ? 'Loading write-offs…' : 'No write-offs found for this period.'}</Box></td></tr>}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={Boolean(editRow)} onClose={() => !saving && setEditRow(null)} fullWidth maxWidth="xs">
        <DialogTitle>Edit Write-off</DialogTitle>
        <DialogContent dividers><Stack gap={2} sx={{ pt: 1 }}><TextField label="Amount" type="number" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} inputProps={{ min: 0.01, step: 0.01 }} /><TextField label="Date" type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} InputLabelProps={{ shrink: true }} /><TextField label="Reason / Note" value={editNote} onChange={(e) => setEditNote(e.target.value)} multiline minRows={2} /></Stack></DialogContent>
        <DialogActions><Button onClick={() => setEditRow(null)} disabled={saving}>Cancel</Button><Button variant="contained" onClick={saveEdit} disabled={saving || Number(editAmount) <= 0}>Save</Button></DialogActions>
      </Dialog>
    </Stack>
  )
}
