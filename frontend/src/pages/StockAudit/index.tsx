import { useMemo, useState } from 'react'
import {
  Box,
  Typography,
  Paper,
  Stack,
  Button,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  MenuItem,
} from '@mui/material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import AddBoxIcon from '@mui/icons-material/AddBox'
import ViewWeekOutlinedIcon from '@mui/icons-material/ViewWeekOutlined'
import {
  listAudits,
  createAudit,
  getAudit,
  getAuditItems,
  updatePhysicalStock,
  finalizeAudit,
  type StockAuditItem,
} from '../../services/audit'
import { useToast } from '../../components/ui/Toaster'
import Loading from '../../components/ui/Loading'

function formatDate(value?: string | null) {
  if (!value) return '-'
  return new Date(value).toLocaleDateString()
}

function rackLabel(rack?: number | null) {
  if (rack === null || rack === undefined) return 'Unassigned'
  return `Rack ${rack}`
}

function AuditDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [rackFilter, setRackFilter] = useState<'ALL' | number>('ALL')

  const qAudit = useQuery({
    queryKey: ['audit', id],
    queryFn: () => getAudit(id),
  })

  const qItems = useQuery({
    queryKey: ['audit-items', id, rackFilter],
    queryFn: () => getAuditItems(id, rackFilter === 'ALL' ? null : rackFilter),
  })

  const allItems = qc.getQueryData<StockAuditItem[]>(['audit-items', id, 'ALL']) || qItems.data || []
  const rackOptions = useMemo(() => {
    const seen = new Set<number>()
    for (const item of allItems) {
      if (item.item_rack !== null && item.item_rack !== undefined) {
        seen.add(item.item_rack)
      }
    }
    return Array.from(seen).sort((a, b) => a - b)
  }, [allItems])

  const mUpdateStock = useMutation({
    mutationFn: ({ itemId, val }: { itemId: number; val: number }) => updatePhysicalStock(id, itemId, val),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['audit-items', id] })
    },
    onError: () => toast.push('Failed to update physical stock', 'error'),
  })

  const mFinalize = useMutation({
    mutationFn: () => finalizeAudit(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['audit', id] })
      qc.invalidateQueries({ queryKey: ['audits'] })
      qc.invalidateQueries({ queryKey: ['audit-items', id] })
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-stats'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory'] })
      toast.push('Audit finalized and ledger updated!', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to finalize audit'
      toast.push(msg, 'error')
    },
  })

  if (qAudit.isLoading || qItems.isLoading) return <Loading />

  const audit = qAudit.data
  const items = qItems.data || []
  const isDraft = audit?.status === 'DRAFT'

  const groupedItems = useMemo(() => {
    const map = new Map<string, StockAuditItem[]>()
    for (const item of items) {
      const key = rackLabel(item.item_rack)
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }

    return Array.from(map.entries()).sort((a, b) => {
      const ar = a[1][0]?.item_rack ?? Number.MAX_SAFE_INTEGER
      const br = b[1][0]?.item_rack ?? Number.MAX_SAFE_INTEGER
      return ar - br
    })
  }, [items])

  const counted = items.filter((item) => item.physical_stock !== null && item.physical_stock !== undefined).length
  const totalDiff = items.reduce((sum, item) => {
    if (item.physical_stock === null || item.physical_stock === undefined) return sum
    return sum + (item.physical_stock - item.system_stock)
  }, 0)

  return (
    <Stack gap={2}>
      <Stack direction="row" gap={2} alignItems="center">
        <IconButton onClick={onBack} sx={{ bgcolor: 'action.hover' }}>
          <ArrowBackIcon />
        </IconButton>
        <Box flex={1}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {audit?.name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {audit?.status === 'DRAFT' ? 'In Progress' : `Completed on ${formatDate(audit?.closed_at)}`}
          </Typography>
        </Box>

        {isDraft && (
          <Button
            variant="contained"
            color="success"
            onClick={() => {
              if (window.confirm('Are you sure? This will generate stock adjustments for discrepancies and disable further edits.')) {
                mFinalize.mutate()
              }
            }}
            disabled={mFinalize.isPending}
          >
            Finalize Actions
          </Button>
        )}
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} alignItems={{ md: 'center' }}>
          <Chip icon={<ViewWeekOutlinedIcon />} label={`${counted}/${items.length} counted`} />
          <Chip
            label={`Net difference ${totalDiff > 0 ? `+${totalDiff}` : totalDiff}`}
            color={totalDiff === 0 ? 'default' : totalDiff > 0 ? 'success' : 'error'}
          />
          <TextField
            select
            size="small"
            label="Rack"
            value={rackFilter}
            onChange={(e) => setRackFilter(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
            sx={{ minWidth: 180, ml: { md: 'auto' } }}
          >
            <MenuItem value="ALL">All racks</MenuItem>
            {rackOptions.map((rack) => (
              <MenuItem key={rack} value={rack}>
                {rackLabel(rack)}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </Paper>

      {groupedItems.map(([groupName, rackItems]) => (
        <Paper key={groupName} sx={{ overflow: 'hidden' }}>
          <Box sx={{ px: 2, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {groupName}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {rackItems.length} item{rackItems.length === 1 ? '' : 's'}
              </Typography>
            </Stack>
          </Box>

          <TableContainer>
            <Table size="small">
              <TableHead sx={{ bgcolor: 'rgba(0,0,0,0.03)' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>Medicine / Item</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Brand</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>MRP</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 600 }}>System Stock</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 600, width: 140 }}>Physical Stock</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 600 }}>Difference</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rackItems.map((it) => {
                  const diff =
                    it.physical_stock !== null && it.physical_stock !== undefined
                      ? it.physical_stock - it.system_stock
                      : null
                  const isDiff = diff !== null && diff !== 0

                  return (
                    <TableRow
                      key={it.id}
                      hover
                      sx={{
                        bgcolor: isDiff
                          ? diff! > 0
                            ? 'rgba(76,175,80,0.08)'
                            : 'rgba(244,67,54,0.08)'
                          : undefined,
                      }}
                    >
                      <TableCell>
                        <Typography variant="body2" fontWeight={600}>
                          {it.item_name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {it.item_expiry || 'No Expiry'}
                        </Typography>
                      </TableCell>
                      <TableCell>{it.item_brand || '-'}</TableCell>
                      <TableCell>{it.item_mrp}</TableCell>
                      <TableCell align="center">
                        <Chip size="small" label={it.system_stock} />
                      </TableCell>
                      <TableCell align="center">
                        {isDraft ? (
                          <TextField
                            size="small"
                            type="number"
                            placeholder="Count"
                            defaultValue={it.physical_stock ?? ''}
                            onBlur={(e) => {
                              const val = e.target.value
                              if (val === '') return
                              const num = parseInt(val, 10)
                              if (!isNaN(num) && num !== it.physical_stock) {
                                mUpdateStock.mutate({ itemId: it.id, val: num })
                              }
                            }}
                            inputProps={{ style: { textAlign: 'center', padding: '4px 8px' }, min: 0 }}
                          />
                        ) : (
                          <Typography variant="body2" fontWeight={600}>
                            {it.physical_stock ?? '-'}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="center">
                        {diff !== null ? (
                          <Typography
                            variant="body2"
                            color={diff < 0 ? 'error.main' : diff > 0 ? 'success.main' : 'text.secondary'}
                            fontWeight={600}
                          >
                            {diff > 0 ? `+${diff}` : diff}
                          </Typography>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      ))}

      {groupedItems.length === 0 && (
        <Paper sx={{ p: 4 }}>
          <Typography align="center" color="text.secondary">
            No items found for this rack.
          </Typography>
        </Paper>
      )}
    </Stack>
  )
}

export default function StockAudits() {
  const [selectedAuditId, setSelectedAuditId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const qc = useQueryClient()
  const toast = useToast()

  const { data: audits, isLoading } = useQuery({
    queryKey: ['audits'],
    queryFn: listAudits,
  })

  const mCreate = useMutation({
    mutationFn: (name: string) => createAudit(name),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['audits'] })
      setShowCreate(false)
      setNewName('')
      setSelectedAuditId(data.id)
    },
    onError: () => toast.push('Failed to create audit', 'error'),
  })

  if (selectedAuditId) {
    return <AuditDetail id={selectedAuditId} onBack={() => setSelectedAuditId(null)} />
  }

  return (
    <Stack gap={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">Stock Reconciliation & Audit</Typography>
        <Button variant="contained" startIcon={<AddBoxIcon />} onClick={() => setShowCreate(true)}>
          New Audit
        </Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        {isLoading ? (
          <Loading />
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>ID</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created / Finalized</TableCell>
                  <TableCell align="right">Action</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {audits?.map((a) => (
                  <TableRow key={a.id} hover>
                    <TableCell>#{a.id}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{a.name}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={a.status}
                        color={a.status === 'DRAFT' ? 'warning' : 'success'}
                        variant={a.status === 'DRAFT' ? 'outlined' : 'filled'}
                        sx={{ fontWeight: 700 }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{formatDate(a.created_at)}</Typography>
                      {a.closed_at && (
                        <Typography variant="caption" color="text.secondary">
                          Finished: {formatDate(a.closed_at)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" variant="outlined" onClick={() => setSelectedAuditId(a.id)}>
                        {a.status === 'DRAFT' ? 'Continue' : 'View Report'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {audits?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      No stock audits started. Create one to begin inventory reconciliation.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      <Dialog open={showCreate} onClose={() => setShowCreate(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Start New Stock Audit</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            This will take a snapshot of your current inventory levels. You can then begin physically counting your stock and entering it into the system.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Audit Title (e.g. FY 24 Year End, March Audit)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowCreate(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!newName.trim() || mCreate.isPending}
            onClick={() => mCreate.mutate(newName)}
          >
            Snapshot & Start
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
