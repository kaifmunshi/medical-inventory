import { useState } from 'react'
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
  IconButton
} from '@mui/material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import AddBoxIcon from '@mui/icons-material/AddBox'
import {
  listAudits,
  createAudit,
  getAudit,
  getAuditItems,
  updatePhysicalStock,
  finalizeAudit
} from '../../services/audit'
import { useToast } from '../../components/ui/Toaster'
import Loading from '../../components/ui/Loading'

function AuditDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()

  const qAudit = useQuery({
    queryKey: ['audit', id],
    queryFn: () => getAudit(id)
  })

  const qItems = useQuery({
    queryKey: ['audit-items', id],
    queryFn: () => getAuditItems(id)
  })

  const mUpdateStock = useMutation({
    mutationFn: ({ itemId, val }: { itemId: number; val: number }) => updatePhysicalStock(id, itemId, val),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['audit-items', id] })
    },
    onError: () => toast.push('Failed to update physical stock', 'error')
  })

  const mFinalize = useMutation({
    mutationFn: () => finalizeAudit(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['audit', id] })
      qc.invalidateQueries({ queryKey: ['audits'] })
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-stats'] })
      toast.push('Audit Finalized and Ledger updated!', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || 'Failed to finalize audit'
      toast.push(msg, 'error')
    }
  })

  if (qAudit.isLoading || qItems.isLoading) return <Loading />

  const audit = qAudit.data
  const items = qItems.data || []
  const isDraft = audit?.status === 'DRAFT'

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
            {audit?.status === 'DRAFT' ? 'In Progress' : 'Completed on ' + new Date(audit?.closed_at || '').toLocaleDateString()}
          </Typography>
        </Box>

        {isDraft && (
          <Button
            variant="contained"
            color="success"
            onClick={() => {
              if (window.confirm("Are you sure? This will generate stock adjustments for any discrepancies and disable further edits!")) {
                mFinalize.mutate()
              }
            }}
            disabled={mFinalize.isPending}
          >
            Finalize Actions
          </Button>
        )}
      </Stack>

      <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid rgba(0,0,0,0.1)' }}>
        <Table size="small">
          <TableHead sx={{ bgcolor: 'rgba(0,0,0,0.03)' }}>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>Medicine / Item</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Brand</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Rack</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>MRP</TableCell>
              <TableCell align="center" sx={{ fontWeight: 600 }}>System Stock</TableCell>
              <TableCell align="center" sx={{ fontWeight: 600, width: 140 }}>Physical Stock</TableCell>
              <TableCell align="center" sx={{ fontWeight: 600 }}>Difference</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((it) => {
              const diff = it.physical_stock !== null && it.physical_stock !== undefined ? (it.physical_stock - it.system_stock) : null
              const isDiff = diff !== null && diff !== 0

              return (
                <TableRow key={it.id} hover sx={{ bgcolor: isDiff ? (diff > 0 ? 'rgba(76,175,80,0.08)' : 'rgba(244,67,54,0.08)') : undefined }}>
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>
                      {it.item_name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {it.item_expiry || 'No Expiry'}
                    </Typography>
                  </TableCell>
                  <TableCell>{it.item_brand || '-'}</TableCell>
                  <TableCell>{it.item_rack || '-'}</TableCell>
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
                        inputProps={{ style: { textAlign: 'center', padding: '4px 8px' } }}
                      />
                    ) : (
                      <Typography variant="body2" fontWeight={600}>
                        {it.physical_stock ?? '-'}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="center">
                    {diff !== null ? (
                      <Typography variant="body2" color={diff < 0 ? 'error.main' : diff > 0 ? 'success.main' : 'text.secondary'} fontWeight={600}>
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
    queryFn: listAudits
  })

  const mCreate = useMutation({
    mutationFn: (name: string) => createAudit(name),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['audits'] })
      setShowCreate(false)
      setNewName('')
      setSelectedAuditId(data.id)
    },
    onError: () => toast.push('Failed to create audit', 'error')
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
                      <Typography variant="body2">{new Date(a.created_at).toLocaleDateString()}</Typography>
                      {a.closed_at && (
                        <Typography variant="caption" color="text.secondary">
                          Finished: {new Date(a.closed_at).toLocaleDateString()}
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
