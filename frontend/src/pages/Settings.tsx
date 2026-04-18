import { useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useToast } from '../components/ui/Toaster'
import type { AuditLog, FinancialYear } from '../lib/types'
import { createFinancialYear, fetchAuditLogs, fetchFinancialYears, updateFinancialYear } from '../services/settings'

function humanizeEntity(entityType?: string | null) {
  return String(entityType || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function summarizeAuditDetails(input?: string | null) {
  if (!input) return '-'
  try {
    const parsed = JSON.parse(input)
    if (parsed && typeof parsed === 'object') {
      const before = (parsed as any).before
      const after = (parsed as any).after
      if (before && after && typeof before === 'object' && typeof after === 'object') {
        const changed = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
        const important = changed.filter((k) => !['id', 'created_at', 'updated_at'].includes(k))
        if (important.length > 0) return `Changed: ${important.join(', ')}`
        if (changed.length > 0) return `Updated ${changed.length} fields`
      }
      const keys = Object.keys(parsed).filter((k) => !['before', 'after', 'id', 'created_at', 'updated_at'].includes(k))
      if (keys.length > 0) return keys.map((k) => `${k}: ${String((parsed as any)[k])}`).join(' | ')
      return 'Updated record'
    }
  } catch {
    // fall through
  }
  return '-'
}

export default function Settings() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const today = new Date().toISOString().slice(0, 10)
  const nextYearEnd = `${Number(today.slice(0, 4)) + 1}-${today.slice(5)}`

  const [createOpen, setCreateOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(nextYearEnd)
  const [isActive, setIsActive] = useState(true)
  const [auditQuery, setAuditQuery] = useState('')
  const yearsQ = useQuery<FinancialYear[], Error>({
    queryKey: ['settings-financial-years'],
    queryFn: fetchFinancialYears,
  })

  const auditQ = useQuery<AuditLog[], Error>({
    queryKey: ['settings-audit-logs', auditQuery],
    queryFn: () => fetchAuditLogs({ q: auditQuery.trim() || undefined, limit: 200 }),
  })

  const createYearM = useMutation({
    mutationFn: createFinancialYear,
    onSuccess: () => {
      toast.push('Financial year created', 'success')
      queryClient.invalidateQueries({ queryKey: ['settings-financial-years'] })
      queryClient.invalidateQueries({ queryKey: ['settings-audit-logs'] })
      setCreateOpen(false)
      setLabel('')
      setStartDate(today)
      setEndDate(nextYearEnd)
      setIsActive(true)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to create financial year'), 'error'),
  })

  const updateYearM = useMutation({
    mutationFn: ({ yearId, payload }: { yearId: number; payload: Partial<FinancialYear> }) => updateFinancialYear(yearId, payload),
    onSuccess: () => {
      toast.push('Financial year updated', 'success')
      queryClient.invalidateQueries({ queryKey: ['settings-financial-years'] })
      queryClient.invalidateQueries({ queryKey: ['settings-audit-logs'] })
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to update financial year'), 'error'),
  })

  function submitYear() {
    createYearM.mutate({
      label: label.trim(),
      start_date: startDate,
      end_date: endDate,
      is_active: isActive,
    })
  }

  return (
    <Stack gap={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
        <Typography variant="h5">Settings</Typography>
        <Button variant="contained" onClick={() => setCreateOpen(true)}>
          Add Financial Year
        </Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Financial Years</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Start</th>
                <th>End</th>
                <th>Active</th>
                <th>Locked</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(yearsQ.data || []).map((year) => (
                <tr key={year.id}>
                  <td>{year.label}</td>
                  <td>{year.start_date}</td>
                  <td>{year.end_date}</td>
                  <td>{year.is_active ? 'Yes' : 'No'}</td>
                  <td>{year.is_locked ? 'Yes' : 'No'}</td>
                  <td>
                    <Stack direction={{ xs: 'column', md: 'row' }} gap={1}>
                      <Button size="small" onClick={() => updateYearM.mutate({ yearId: year.id, payload: { is_active: !year.is_active } })}>
                        {year.is_active ? 'Deactivate' : 'Set Active'}
                      </Button>
                      <Button
                        size="small"
                        color={year.is_locked ? 'warning' : 'error'}
                        onClick={() => updateYearM.mutate({ yearId: year.id, payload: { is_locked: !year.is_locked } })}
                      >
                        {year.is_locked ? 'Unlock' : 'Lock'}
                      </Button>
                    </Stack>
                  </td>
                </tr>
              ))}
              {(yearsQ.data || []).length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <Box p={2} color="text.secondary">No financial years configured yet.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2} sx={{ mb: 2 }}>
          <Typography variant="h6">Audit Trail</Typography>
          <TextField
            label="Search Audit"
            value={auditQuery}
            onChange={(e) => setAuditQuery(e.target.value)}
            placeholder="bill, purchase, payment, actor"
            sx={{ minWidth: 240 }}
          />
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Entity</th>
                <th>Action</th>
                <th>Note</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {(auditQ.data || []).map((row) => (
                <tr key={row.id}>
                  <td>{String(row.event_ts || '').replace('T', ' ')}</td>
                  <td>{row.actor || 'system'}</td>
                  <td>{humanizeEntity(row.entity_type) || '-'}</td>
                  <td>{row.action}</td>
                  <td>{row.note || '-'}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', minWidth: 260 }}>{summarizeAuditDetails(row.details_json)}</td>
                </tr>
              ))}
              {(auditQ.data || []).length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <Box p={2} color="text.secondary">No audit log rows found.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add Financial Year</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ mt: 1 }}>
            <TextField label="Label" value={label} onChange={(e) => setLabel(e.target.value)} fullWidth />
            <TextField label="Start Date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} InputLabelProps={{ shrink: true }} />
            <TextField label="End Date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} InputLabelProps={{ shrink: true }} />
            <FormControlLabel
              control={<Checkbox checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />}
              label="Set as active year"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={submitYear}>Save</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
