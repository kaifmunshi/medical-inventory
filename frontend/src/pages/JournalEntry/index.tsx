import { useEffect, useMemo, useState } from 'react'
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import RestoreIcon from '@mui/icons-material/Restore'
import SaveIcon from '@mui/icons-material/Save'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useToast } from '../../components/ui/Toaster'
import type { Ledger, PostedVoucher } from '../../lib/types'
import {
  createLedger,
  createJournalVoucher,
  deleteJournalVoucher,
  listJournalVouchers,
  listLedgerGroups,
  listLedgers,
  restoreJournalVoucher,
  updateJournalVoucher,
  type JournalVoucherPayload,
} from '../../services/vouchers'

type EntryType = 'DR' | 'CR'

type JournalLineDraft = {
  key: string
  ledger: Ledger | null
  entry_type: EntryType
  amount: string
  narration: string
}

function makeKey() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function todayYmd() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function daysAgoYmd(days: number) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function money(value: number | string | null | undefined) {
  return Number(value || 0).toFixed(2)
}

function makeLine(entryType: EntryType): JournalLineDraft {
  return {
    key: makeKey(),
    ledger: null,
    entry_type: entryType,
    amount: '',
    narration: '',
  }
}

function ledgerFromEntry(entry: PostedVoucher['entries'][number]): Ledger {
  const now = ''
  return {
    id: entry.ledger_id,
    name: entry.ledger_name || `Ledger #${entry.ledger_id}`,
    group_id: 0,
    party_id: null,
    system_key: null,
    is_system: false,
    is_active: true,
    created_at: now,
    updated_at: now,
  }
}

function entrySummary(voucher: PostedVoucher) {
  return voucher.entries
    .map((entry) => `${entry.ledger_name || `Ledger #${entry.ledger_id}`} ${entry.entry_type} ${money(entry.amount)}`)
    .join(' | ')
}

export default function JournalEntryPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const today = useMemo(() => todayYmd(), [])

  const [editingId, setEditingId] = useState<number | null>(null)
  const [voucherDate, setVoucherDate] = useState(today)
  const [voucherNo, setVoucherNo] = useState('')
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<JournalLineDraft[]>([makeLine('DR'), makeLine('CR')])

  const [activeLedgerLine, setActiveLedgerLine] = useState<string | null>(null)
  const [ledgerSearch, setLedgerSearch] = useState('')
  const [debouncedLedgerSearch, setDebouncedLedgerSearch] = useState('')
  const [ledgerDialogOpen, setLedgerDialogOpen] = useState(false)
  const [ledgerCreateLineKey, setLedgerCreateLineKey] = useState<string | null>(null)
  const [newLedgerName, setNewLedgerName] = useState('')
  const [newLedgerGroupId, setNewLedgerGroupId] = useState('')

  const [fromDate, setFromDate] = useState(daysAgoYmd(30))
  const [toDate, setToDate] = useState(today)
  const [listSearch, setListSearch] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)

  useEffect(() => {
    const term = ledgerSearch.trim()
    if (term.length < 2) {
      setDebouncedLedgerSearch('')
      return undefined
    }
    const timer = window.setTimeout(() => setDebouncedLedgerSearch(term), 250)
    return () => window.clearTimeout(timer)
  }, [ledgerSearch])

  const canSearchLedgers = Boolean(activeLedgerLine) && debouncedLedgerSearch.length >= 2
  const ledgersQ = useQuery({
    queryKey: ['journal-ledgers', debouncedLedgerSearch],
    queryFn: () => listLedgers({ q: debouncedLedgerSearch }),
    enabled: canSearchLedgers,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

  const ledgerGroupsQ = useQuery({
    queryKey: ['journal-ledger-groups'],
    queryFn: listLedgerGroups,
    enabled: ledgerDialogOpen,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  })
  const activeLedgerGroups = useMemo(() => (ledgerGroupsQ.data || []).filter((group) => group.is_active), [ledgerGroupsQ.data])

  useEffect(() => {
    if (ledgerDialogOpen && !newLedgerGroupId && activeLedgerGroups.length > 0) {
      setNewLedgerGroupId(String(activeLedgerGroups[0].id))
    }
  }, [activeLedgerGroups, ledgerDialogOpen, newLedgerGroupId])

  const journalsQ = useQuery({
    queryKey: ['journal-vouchers', fromDate, toDate, listSearch, showDeleted],
    queryFn: () =>
      listJournalVouchers({
        from_date: fromDate,
        to_date: toDate,
        q: listSearch.trim() || undefined,
        deleted_filter: showDeleted ? 'all' : 'active',
        limit: 300,
      }),
  })

  const debitTotal = useMemo(
    () => lines.reduce((sum, line) => line.entry_type === 'DR' ? sum + Number(line.amount || 0) : sum, 0),
    [lines],
  )
  const creditTotal = useMemo(
    () => lines.reduce((sum, line) => line.entry_type === 'CR' ? sum + Number(line.amount || 0) : sum, 0),
    [lines],
  )
  const balanceDiff = Number((debitTotal - creditTotal).toFixed(2))
  const isBalanced = debitTotal > 0 && Math.abs(balanceDiff) <= 0.009

  function resetForm() {
    setEditingId(null)
    setVoucherDate(todayYmd())
    setVoucherNo('')
    setNarration('')
    setLines([makeLine('DR'), makeLine('CR')])
    setActiveLedgerLine(null)
    setLedgerSearch('')
    setDebouncedLedgerSearch('')
  }

  function updateLine(key: string, patch: Partial<JournalLineDraft>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)))
  }

  function optionsForLine(line: JournalLineDraft) {
    const options = activeLedgerLine === line.key && canSearchLedgers ? (ledgersQ.data || []) : []
    const byId = new Map<number, Ledger>()
    if (line.ledger) byId.set(Number(line.ledger.id), line.ledger)
    for (const ledger of options) byId.set(Number(ledger.id), ledger)
    return Array.from(byId.values())
  }

  function openLedgerDialog(lineKey?: string, seedName = '') {
    const targetKey = lineKey || activeLedgerLine
    setLedgerCreateLineKey(targetKey)
    if (lineKey) setActiveLedgerLine(lineKey)
    setNewLedgerName(seedName.trim())
    setLedgerDialogOpen(true)
  }

  function resetLedgerDialog() {
    setLedgerDialogOpen(false)
    setLedgerCreateLineKey(null)
    setNewLedgerName('')
    setNewLedgerGroupId('')
  }

  function buildPayload(): JournalVoucherPayload | null {
    const incompleteAmountLine = lines.find((line) => Number(line.amount || 0) > 0 && !line.ledger)
    if (incompleteAmountLine) {
      toast.push('Select a ledger for every amount line', 'error')
      return null
    }
    const entries = lines
      .filter((line) => line.ledger && Number(line.amount || 0) > 0)
      .map((line) => ({
        ledger_id: Number(line.ledger?.id),
        entry_type: line.entry_type,
        amount: Number(line.amount || 0),
        narration: line.narration.trim() || undefined,
      }))
    if (entries.length < 2) {
      toast.push('Add at least one debit and one credit line', 'error')
      return null
    }
    if (!isBalanced) {
      toast.push('Debit and credit totals must match', 'error')
      return null
    }
    return {
      voucher_date: voucherDate,
      voucher_no: voucherNo.trim() || undefined,
      narration: narration.trim() || undefined,
      entries,
    }
  }

  const saveM = useMutation({
    mutationFn: async () => {
      const payload = buildPayload()
      if (!payload) throw new Error('Journal entry is incomplete')
      return editingId
        ? updateJournalVoucher(editingId, payload)
        : createJournalVoucher(payload)
    },
    onSuccess: (saved) => {
      toast.push(`Journal ${saved.voucher_no} saved`, 'success')
      resetForm()
      queryClient.invalidateQueries({ queryKey: ['journal-vouchers'] })
      queryClient.invalidateQueries({ queryKey: ['voucher-day-book'] })
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Journal save failed'
      if (msg !== 'Journal entry is incomplete') toast.push(String(msg), 'error')
    },
  })

  const deleteM = useMutation({
    mutationFn: (id: number) => deleteJournalVoucher(id),
    onSuccess: () => {
      toast.push('Journal deleted', 'success')
      queryClient.invalidateQueries({ queryKey: ['journal-vouchers'] })
      queryClient.invalidateQueries({ queryKey: ['voucher-day-book'] })
      if (editingId) resetForm()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Delete failed'), 'error'),
  })

  const restoreM = useMutation({
    mutationFn: (id: number) => restoreJournalVoucher(id),
    onSuccess: () => {
      toast.push('Journal restored', 'success')
      queryClient.invalidateQueries({ queryKey: ['journal-vouchers'] })
      queryClient.invalidateQueries({ queryKey: ['voucher-day-book'] })
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Restore failed'), 'error'),
  })

  const createLedgerM = useMutation({
    mutationFn: async () => {
      const name = newLedgerName.trim()
      const groupId = Number(newLedgerGroupId || 0)
      if (!name || !groupId) throw new Error('Ledger name and group are required')
      return createLedger({ name, group_id: groupId })
    },
    onSuccess: (ledger) => {
      toast.push(`Ledger ${ledger.name} created`, 'success')
      const targetKey = ledgerCreateLineKey || activeLedgerLine
      if (targetKey) updateLine(targetKey, { ledger })
      queryClient.invalidateQueries({ queryKey: ['journal-ledgers'] })
      resetLedgerDialog()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Ledger creation failed'), 'error'),
  })

  function saveLedgerFromDialog() {
    if (createLedgerM.isPending) return
    if (!newLedgerName.trim()) {
      toast.push('Ledger name is required', 'warning')
      return
    }
    if (!Number(newLedgerGroupId || 0)) {
      toast.push('Select a ledger group before saving', 'warning')
      return
    }
    createLedgerM.mutate()
  }

  function startEdit(voucher: PostedVoucher) {
    setEditingId(Number(voucher.id))
    setVoucherDate(String(voucher.voucher_date || '').slice(0, 10) || todayYmd())
    setVoucherNo(voucher.voucher_no || '')
    setNarration(voucher.narration || '')
    const nextLines = voucher.entries
      .slice()
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
      .map((entry) => ({
        key: makeKey(),
        ledger: ledgerFromEntry(entry),
        entry_type: entry.entry_type,
        amount: String(entry.amount || ''),
        narration: entry.narration || '',
      }))
    setLines(nextLines.length >= 2 ? nextLines : [makeLine('DR'), makeLine('CR')])
  }

  const journalRows = journalsQ.data || []

  return (
    <Stack gap={2}>
      <Typography variant="h5">Journal Entry</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack gap={2}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5}>
            <TextField
              label="Date"
              type="date"
              value={voucherDate}
              onChange={(e) => setVoucherDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ width: { xs: '100%', md: 180 } }}
            />
            <TextField
              label="Voucher No"
              value={voucherNo}
              onChange={(e) => setVoucherNo(e.target.value)}
              placeholder="Auto"
              sx={{ width: { xs: '100%', md: 190 } }}
            />
            <TextField
              label="Narration"
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              fullWidth
            />
          </Stack>

          <Box sx={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 980, tableLayout: 'fixed', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 360 }}>Ledger</th>
                  <th style={{ width: 96 }}>Dr / Cr</th>
                  <th style={{ width: 150 }}>Amount</th>
                  <th>Narration</th>
                  <th style={{ width: 64 }}></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key}>
                    <td>
                      <Stack direction="row" gap={0.75} alignItems="center">
                        <Autocomplete
                          sx={{ flex: 1, minWidth: 0 }}
                          options={optionsForLine(line)}
                          value={line.ledger}
                          loading={activeLedgerLine === line.key && ledgersQ.isFetching}
                          filterOptions={(options) => options}
                          isOptionEqualToValue={(a, b) => Number(a?.id) === Number(b?.id)}
                          getOptionLabel={(option) => option?.name || ''}
                          onOpen={() => setActiveLedgerLine(line.key)}
                          onClose={() => setActiveLedgerLine((prev) => (prev === line.key ? null : prev))}
                          onInputChange={(_event, value, reason) => {
                            if (reason === 'input') {
                              setActiveLedgerLine(line.key)
                              setLedgerSearch(value || '')
                            }
                            if (reason === 'clear') {
                              setLedgerSearch('')
                            }
                          }}
                          onChange={(_event, value) => updateLine(line.key, { ledger: value })}
                          noOptionsText={canSearchLedgers ? 'No ledgers found' : 'Type 2 letters'}
                          renderInput={(params) => <TextField {...params} size="small" label="Ledger" />}
                          renderOption={(props, option) => (
                            <li {...props} key={option.id}>
                              <Stack sx={{ py: 0.35 }}>
                                <Typography variant="body2" fontWeight={700}>{option.name}</Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {option.is_system ? 'System ledger' : option.party_id ? `Party #${option.party_id}` : 'Ledger'}
                                </Typography>
                              </Stack>
                            </li>
                          )}
                        />
                        <Tooltip title="New ledger">
                          <IconButton
                            size="small"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => openLedgerDialog(line.key, activeLedgerLine === line.key ? ledgerSearch : '')}
                          >
                            <AddIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </td>
                    <td>
                      <TextField
                        select
                        size="small"
                        value={line.entry_type}
                        onChange={(e) => updateLine(line.key, { entry_type: e.target.value as EntryType })}
                        fullWidth
                      >
                        <MenuItem value="DR">Dr</MenuItem>
                        <MenuItem value="CR">Cr</MenuItem>
                      </TextField>
                    </td>
                    <td>
                      <TextField
                        size="small"
                        type="number"
                        value={line.amount}
                        onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                        inputProps={{ min: 0, step: '0.01' }}
                        fullWidth
                      />
                    </td>
                    <td>
                      <TextField
                        size="small"
                        value={line.narration}
                        onChange={(e) => updateLine(line.key, { narration: e.target.value })}
                        fullWidth
                      />
                    </td>
                    <td align="right">
                      <Tooltip title="Remove line">
                        <span>
                          <IconButton
                            size="small"
                            color="error"
                            disabled={lines.length <= 2}
                            onClick={() => setLines((prev) => prev.filter((item) => item.key !== line.key))}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>

          <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} alignItems={{ md: 'center' }} justifyContent="space-between">
            <Stack direction="row" gap={1} flexWrap="wrap">
              <Chip label={`Debit ${money(debitTotal)}`} color={isBalanced ? 'success' : 'default'} />
              <Chip label={`Credit ${money(creditTotal)}`} color={isBalanced ? 'success' : 'default'} />
              <Chip label={`Diff ${money(Math.abs(balanceDiff))}`} color={isBalanced ? 'success' : 'warning'} variant="outlined" />
            </Stack>
            <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="flex-end">
              <Button startIcon={<AddIcon />} variant="outlined" onClick={() => setLines((prev) => [...prev, makeLine('DR')])}>
                Debit
              </Button>
              <Button startIcon={<AddIcon />} variant="outlined" onClick={() => setLines((prev) => [...prev, makeLine('CR')])}>
                Credit
              </Button>
              {editingId ? <Button variant="outlined" onClick={resetForm}>New</Button> : null}
	              <Button
	                startIcon={<SaveIcon />}
	                variant="contained"
	                onClick={() => saveM.mutate()}
	                disabled={saveM.isPending}
	              >
                {saveM.isPending ? 'Saving...' : editingId ? 'Update' : 'Save'}
              </Button>
            </Stack>
          </Stack>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} alignItems={{ md: 'center' }} sx={{ mb: 2 }}>
          <Typography variant="h6" sx={{ flex: 1 }}>Journal Register</Typography>
          <TextField
            label="From"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            size="small"
          />
          <TextField
            label="To"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            size="small"
          />
          <TextField
            label="Search"
            value={listSearch}
            onChange={(e) => setListSearch(e.target.value)}
            size="small"
          />
          <FormControlLabel
            control={<Switch checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />}
            label="Deleted"
          />
        </Stack>

        <Box sx={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Voucher</th>
                <th>Total</th>
                <th>Entries</th>
                <th>Narration</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {journalRows.map((voucher) => (
                <tr key={voucher.id} style={{ opacity: voucher.is_deleted ? 0.62 : 1 }}>
                  <td style={{ minWidth: 110 }}>{voucher.voucher_date}</td>
                  <td style={{ minWidth: 130 }}>{voucher.voucher_no}</td>
                  <td style={{ minWidth: 100 }}>{money(voucher.total_amount)}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', minWidth: 320 }}>{entrySummary(voucher)}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', minWidth: 220 }}>{voucher.narration || '-'}</td>
                  <td>
                    <Chip
                      size="small"
                      label={voucher.is_deleted ? 'Deleted' : 'Posted'}
                      color={voucher.is_deleted ? 'default' : 'success'}
                      variant={voucher.is_deleted ? 'outlined' : 'filled'}
                    />
                  </td>
                  <td align="right" style={{ minWidth: 116 }}>
                    {voucher.is_deleted ? (
                      <Tooltip title="Restore">
                        <IconButton size="small" onClick={() => restoreM.mutate(Number(voucher.id))} disabled={restoreM.isPending}>
                          <RestoreIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    ) : (
                      <>
                        <Tooltip title="Edit">
                          <IconButton size="small" onClick={() => startEdit(voucher)}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton
                            size="small"
                            color="error"
                            disabled={deleteM.isPending}
                            onClick={() => {
                              const ok = window.confirm(`Delete journal voucher ${voucher.voucher_no}?`)
                              if (ok) deleteM.mutate(Number(voucher.id))
                            }}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {journalRows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <Box p={2} color="text.secondary">
                      {journalsQ.isLoading ? 'Loading journal entries...' : 'No journal entries found.'}
                    </Box>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog
        open={ledgerDialogOpen}
        onClose={() => {
          if (!createLedgerM.isPending) resetLedgerDialog()
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Add Ledger</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ pt: 0.5 }}>
            <TextField
              autoFocus
              label="Ledger Name"
              value={newLedgerName}
              onChange={(e) => setNewLedgerName(e.target.value)}
              fullWidth
            />
            <TextField
              select
              label="Group"
              value={newLedgerGroupId}
              onChange={(e) => setNewLedgerGroupId(e.target.value)}
              disabled={ledgerGroupsQ.isLoading}
              fullWidth
            >
              {activeLedgerGroups.map((group) => (
                <MenuItem key={group.id} value={String(group.id)}>
                  {group.name}
                </MenuItem>
              ))}
              {activeLedgerGroups.length === 0 ? (
                <MenuItem value="">{ledgerGroupsQ.isLoading ? 'Loading...' : 'No active groups'}</MenuItem>
              ) : null}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={resetLedgerDialog} disabled={createLedgerM.isPending}>Cancel</Button>
	          <Button
	            startIcon={<SaveIcon />}
	            variant="contained"
	            onClick={saveLedgerFromDialog}
	            disabled={createLedgerM.isPending}
	          >
            {createLedgerM.isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
