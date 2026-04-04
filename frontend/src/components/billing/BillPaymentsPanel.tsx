import { useMemo, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  editBillPayment,
  getBill,
  listBillPayments,
  receivePayment,
  recoverBillPayment,
  undoBillPayment,
  type BillPaymentRow,
} from '../../services/billing'
import { todayRange } from '../../lib/date'
import ConfirmDialog from '../ui/ConfirmDialog'

function money(n: number | string | undefined | null) {
  return Number(n || 0).toFixed(2)
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

type Props = {
  bill: any
  onBillUpdated?: (bill: any) => void | Promise<void>
}

export default function BillPaymentsPanel({ bill, onBillUpdated }: Props) {
  const { from: todayFrom } = todayRange()
  const [openPayDlg, setOpenPayDlg] = useState(false)
  const [payMode, setPayMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [cash, setCash] = useState<number | ''>('')
  const [online, setOnline] = useState<number | ''>('')
  const [note, setNote] = useState('')
  const [paymentDate, setPaymentDate] = useState(todayFrom)
  const [undoPaymentRow, setUndoPaymentRow] = useState<BillPaymentRow | null>(null)
  const [recoverPaymentRow, setRecoverPaymentRow] = useState<BillPaymentRow | null>(null)
  const [editPaymentRow, setEditPaymentRow] = useState<BillPaymentRow | null>(null)

  const qPayments = useQuery({
    queryKey: ['bill-payments-panel', bill?.id],
    queryFn: () => listBillPayments(Number(bill.id)),
    enabled: Boolean(bill?.id),
  })

  const payPending = useMemo(
    () => round2(Math.max(0, Number(bill?.total_amount || 0) - Number(bill?.paid_amount || 0))),
    [bill]
  )

  const payments = Array.isArray(qPayments.data) ? qPayments.data : []
  const activePayments = useMemo(() => payments.filter((p) => !p?.is_deleted), [payments])
  const deletedPayments = useMemo(() => payments.filter((p) => p?.is_deleted), [payments])

  async function syncBillAndPayments() {
    if (!bill?.id) return
    const nextBill = await getBill(Number(bill.id))
    await qPayments.refetch()
    await onBillUpdated?.(nextBill)
  }

  function resetPayForm() {
    setPayMode('cash')
    setCash('')
    setOnline('')
    setNote('')
    setPaymentDate(todayFrom)
  }

  function paymentDateOnly(raw: any) {
    const s = String(raw || '')
    return s.length >= 10 ? s.slice(0, 10) : todayFrom
  }

  function openReceivePayment() {
    resetPayForm()
    setOpenPayDlg(true)
  }

  function openEditPayment(payment: BillPaymentRow) {
    setEditPaymentRow(payment)
    setPayMode((payment?.mode as any) || 'cash')
    setCash(Number(payment?.cash_amount || 0) || '')
    setOnline(Number(payment?.online_amount || 0) || '')
    setNote(payment?.note || '')
    setPaymentDate(paymentDateOnly(payment?.received_at))
  }

  function handleSplitCash(raw: string) {
    if (payMode !== 'split') {
      setCash(raw === '' ? '' : Number(raw))
      return
    }
    if (raw === '') {
      setCash('')
      setOnline(payPending > 0 ? payPending : '')
      return
    }
    const c = Math.min(payPending, Math.max(0, round2(Number(raw))))
    setCash(c)
    setOnline(round2(Math.max(0, payPending - c)))
  }

  function handleSplitOnline(raw: string) {
    if (payMode !== 'split') {
      setOnline(raw === '' ? '' : Number(raw))
      return
    }
    if (raw === '') {
      setOnline('')
      setCash(payPending > 0 ? payPending : '')
      return
    }
    const o = Math.min(payPending, Math.max(0, round2(Number(raw))))
    setOnline(o)
    setCash(round2(Math.max(0, payPending - o)))
  }

  const mPay = useMutation({
    mutationFn: async () => {
      if (!bill?.id) throw new Error('Bill missing')
      const cashAmt = Number(cash || 0)
      const onlineAmt = Number(online || 0)

      if (payMode === 'cash' && onlineAmt !== 0) throw new Error('Online must be 0 for cash mode')
      if (payMode === 'online' && cashAmt !== 0) throw new Error('Cash must be 0 for online mode')
      if (payMode !== 'split' && cashAmt + onlineAmt <= 0) throw new Error('Amount must be > 0')
      if (payMode === 'split' && cashAmt + onlineAmt <= 0) throw new Error('Split must have some amount')

      return receivePayment(Number(bill.id), {
        mode: payMode,
        cash_amount: cashAmt,
        online_amount: onlineAmt,
        note: note || undefined,
        payment_date: paymentDate || undefined,
      })
    },
    onSuccess: async () => {
      setOpenPayDlg(false)
      resetPayForm()
      await syncBillAndPayments()
    },
  })

  const mEditPay = useMutation({
    mutationFn: async () => {
      if (!bill?.id || !editPaymentRow?.id) throw new Error('Payment missing')
      const cashAmt = Number(cash || 0)
      const onlineAmt = Number(online || 0)

      if (payMode === 'cash' && onlineAmt !== 0) throw new Error('Online must be 0 for cash mode')
      if (payMode === 'online' && cashAmt !== 0) throw new Error('Cash must be 0 for online mode')
      if (payMode !== 'split' && cashAmt + onlineAmt <= 0) throw new Error('Amount must be > 0')
      if (payMode === 'split' && cashAmt + onlineAmt <= 0) throw new Error('Split must have some amount')

      return editBillPayment(Number(bill.id), Number(editPaymentRow.id), {
        mode: payMode,
        cash_amount: cashAmt,
        online_amount: onlineAmt,
        note: note || undefined,
        payment_date: paymentDate || undefined,
      })
    },
    onSuccess: async () => {
      setEditPaymentRow(null)
      resetPayForm()
      await syncBillAndPayments()
    },
  })

  const mUndoPay = useMutation({
    mutationFn: async (payment: BillPaymentRow) => undoBillPayment(Number(bill.id), Number(payment.id)),
    onSuccess: async () => {
      setUndoPaymentRow(null)
      await syncBillAndPayments()
    },
  })

  const mRecoverPay = useMutation({
    mutationFn: async (payment: BillPaymentRow) => recoverBillPayment(Number(bill.id), Number(payment.id)),
    onSuccess: async () => {
      setRecoverPaymentRow(null)
      await syncBillAndPayments()
    },
  })

  return (
    <>
      {!bill?.is_deleted ? (
        <Box textAlign={{ xs: 'left', md: 'right' }}>
          {payPending > 0.0001 ? (
            <Button variant="contained" onClick={openReceivePayment} disabled={mPay.isPending}>
              Receive Payment
            </Button>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Bill fully paid
            </Typography>
          )}
        </Box>
      ) : null}

      <Typography variant="subtitle1">Payment History</Typography>
      {qPayments.isLoading ? (
        <Typography color="text.secondary">Loading payments…</Typography>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 120 }}>Date</th>
                <th>Mode</th>
                <th>Cash</th>
                <th>Online</th>
                <th style={{ minWidth: 220 }}>Note</th>
                <th style={{ width: 64 }}></th>
              </tr>
            </thead>
            <tbody>
              {activePayments.map((p) => (
                <tr key={p.id}>
                  <td style={{ maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.received_at ? String(p.received_at).slice(0, 10) : '-'}
                  </td>
                  <td>{p.mode || '-'}</td>
                  <td>{money(p.cash_amount)}</td>
                  <td>{money(p.online_amount)}</td>
                  <td style={{ minWidth: 220 }}>{p.note || ''}</td>
                  <td align="right">
                    <Box
                      sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: 0.25,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <IconButton size="small" onClick={() => openEditPayment(p)} disabled={mEditPay.isPending} color="primary" sx={{ p: 0.25 }}>
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" color="error" onClick={() => setUndoPaymentRow(p)} disabled={mUndoPay.isPending} sx={{ p: 0.25 }}>
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </td>
                </tr>
              ))}
              {activePayments.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <Box p={2} color="text.secondary">
                      No active payments.
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      )}

      <Typography variant="subtitle1">Deleted Payment History</Typography>
      <Box sx={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Date</th>
              <th>Mode</th>
              <th>Cash</th>
              <th>Online</th>
              <th style={{ minWidth: 220 }}>Note</th>
              <th style={{ width: 120 }}>Deleted</th>
              <th style={{ width: 64 }}></th>
            </tr>
          </thead>
          <tbody>
            {deletedPayments.map((p) => (
              <tr key={`deleted-${p.id}`}>
                <td style={{ maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.received_at ? String(p.received_at).slice(0, 10) : '-'}
                </td>
                <td>{p.mode || '-'}</td>
                <td>{money(p.cash_amount)}</td>
                <td>{money(p.online_amount)}</td>
                <td style={{ minWidth: 220 }}>{p.note || ''}</td>
                <td style={{ maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.deleted_at ? String(p.deleted_at).slice(0, 10) : '-'}
                </td>
                <td align="right">
                  <Button size="small" variant="outlined" onClick={() => setRecoverPaymentRow(p)} disabled={mRecoverPay.isPending} sx={{ minWidth: 0, px: 1 }}>
                    Recover
                  </Button>
                </td>
              </tr>
            ))}
            {deletedPayments.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <Box p={2} color="text.secondary">
                    No deleted payments.
                  </Box>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Box>

      <ConfirmDialog
        open={Boolean(undoPaymentRow)}
        title="Undo Payment"
        onClose={() => {
          if (!mUndoPay.isPending) setUndoPaymentRow(null)
        }}
        onConfirm={() => {
          if (undoPaymentRow) mUndoPay.mutate(undoPaymentRow)
        }}
      >
        <Typography sx={{ mt: 1 }}>
          Undo payment of Rs.{money(Number(undoPaymentRow?.cash_amount || 0) + Number(undoPaymentRow?.online_amount || 0))}
          {undoPaymentRow?.received_at ? ` received at ${undoPaymentRow.received_at}` : ''}?
        </Typography>
        {mUndoPay.isError ? (
          <Typography color="error" sx={{ mt: 1 }}>
            {(mUndoPay.error as any)?.message || 'Undo failed'}
          </Typography>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(recoverPaymentRow)}
        title="Recover Payment"
        onClose={() => {
          if (!mRecoverPay.isPending) setRecoverPaymentRow(null)
        }}
        onConfirm={() => {
          if (recoverPaymentRow) mRecoverPay.mutate(recoverPaymentRow)
        }}
      >
        <Typography sx={{ mt: 1 }}>
          Recover payment of Rs.{money(Number(recoverPaymentRow?.cash_amount || 0) + Number(recoverPaymentRow?.online_amount || 0))}
          {recoverPaymentRow?.received_at ? ` received at ${recoverPaymentRow.received_at}` : ''}?
        </Typography>
        {mRecoverPay.isError ? (
          <Typography color="error" sx={{ mt: 1 }}>
            {(mRecoverPay.error as any)?.message || 'Recover failed'}
          </Typography>
        ) : null}
      </ConfirmDialog>

      <Dialog open={Boolean(editPaymentRow)} onClose={() => !mEditPay.isPending && setEditPaymentRow(null)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Edit Payment
          <IconButton onClick={() => !mEditPay.isPending && setEditPaymentRow(null)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
            <TextField
              select
              label="Mode"
              value={payMode}
              onChange={(e) => {
                const v = e.target.value as any
                setPayMode(v)
                if (v === 'cash') setOnline('')
                if (v === 'online') setCash('')
              }}
            >
              <MenuItem value="cash">Cash</MenuItem>
              <MenuItem value="online">Online</MenuItem>
              <MenuItem value="split">Split</MenuItem>
            </TextField>

            {(payMode === 'cash' || payMode === 'split') && (
              <TextField label="Cash Amount" type="number" value={cash} onChange={(e) => setCash(e.target.value === '' ? '' : Number(e.target.value))} />
            )}
            {(payMode === 'online' || payMode === 'split') && (
              <TextField label="Online Amount" type="number" value={online} onChange={(e) => setOnline(e.target.value === '' ? '' : Number(e.target.value))} />
            )}
            <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <TextField label="Payment Date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} InputLabelProps={{ shrink: true }} />
            <Box textAlign="right">
              <Button variant="contained" onClick={() => mEditPay.mutate()} disabled={mEditPay.isPending}>
                Save Changes
              </Button>
            </Box>
            {mEditPay.isError ? (
              <Typography color="error">{(mEditPay.error as any)?.message || 'Edit failed'}</Typography>
            ) : null}
          </Stack>
        </DialogContent>
      </Dialog>

      <Dialog open={openPayDlg} onClose={() => setOpenPayDlg(false)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Receive Payment (Bill #{bill?.id})
          <IconButton onClick={() => setOpenPayDlg(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
            <Typography color="text.secondary">
              Total Rs.{money(bill?.total_amount)} | Paid Rs.{money(bill?.paid_amount)} | Pending Rs.{money(payPending)}
            </Typography>
            <TextField
              select
              label="Mode"
              value={payMode}
              onChange={(e) => {
                const v = e.target.value as any
                setPayMode(v)
                if (v === 'cash') setOnline('')
                if (v === 'online') setCash('')
                if (v === 'split') {
                  setCash('')
                  setOnline(payPending > 0 ? payPending : '')
                }
              }}
            >
              <MenuItem value="cash">Cash</MenuItem>
              <MenuItem value="online">Online</MenuItem>
              <MenuItem value="split">Split</MenuItem>
            </TextField>
            {(payMode === 'cash' || payMode === 'split') && (
              <TextField label="Cash Amount" type="number" value={cash} onChange={(e) => handleSplitCash(e.target.value)} />
            )}
            {(payMode === 'online' || payMode === 'split') && (
              <TextField label="Online Amount" type="number" value={online} onChange={(e) => handleSplitOnline(e.target.value)} />
            )}
            <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <TextField label="Payment Date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} InputLabelProps={{ shrink: true }} />
            <Box textAlign="right">
              <Button variant="contained" onClick={() => mPay.mutate()} disabled={mPay.isPending}>
                Save Payment
              </Button>
            </Box>
            {mPay.isError ? <Typography color="error">{(mPay.error as any)?.message || 'Payment failed'}</Typography> : null}
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  )
}
