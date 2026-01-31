import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { listItems, getItemLedger } from '../../services/inventory'

function toCSV(rows: string[][]) {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = String(cell ?? '')
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(',')
    )
    .join('\n')
}

export default function StockLedgerReport(props: {
  from: string
  to: string
  setExportFn: (fn: () => void) => void
  setExportDisabled: (v: boolean) => void
  setExtraControls: (node: React.ReactNode) => void
}) {
  const { from, to, setExportFn, setExportDisabled, setExtraControls } = props

  const LIMIT = 30

  const [itemPickerOpen, setItemPickerOpen] = useState(false)
  const [itemSearch, setItemSearch] = useState('')
  const [debouncedItemSearch, setDebouncedItemSearch] = useState('')
  const [pickedItem, setPickedItem] = useState<any | null>(null)
  const [ledgerReason, setLedgerReason] = useState<string>('') // empty = all

  useEffect(() => {
    const t = setTimeout(() => setDebouncedItemSearch(itemSearch.trim()), 300)
    return () => clearTimeout(t)
  }, [itemSearch])

  const qItemSearch = useQuery({
    queryKey: ['rpt-stock-items', debouncedItemSearch],
    enabled: itemPickerOpen && debouncedItemSearch.length > 0,
    queryFn: () => listItems(debouncedItemSearch),
  })

  const qLedger = useInfiniteQuery({
    queryKey: ['rpt-stock-ledger', pickedItem?.id, from, to, ledgerReason],
    enabled: !!pickedItem?.id,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      return await getItemLedger({
        item_id: Number(pickedItem.id),
        from_date: from,
        to_date: to,
        reason: ledgerReason ? ledgerReason : undefined,
        limit: LIMIT,
        offset: pageParam,
      })
    },
    getNextPageParam: (lastPage: any) => lastPage?.next_offset ?? undefined,
  })

  const ledgerRaw = useMemo(() => {
    const pages: any[] = ((qLedger.data as any)?.pages ?? []) as any[]
    const rows: any[] = []
    for (const p of pages) if (p && Array.isArray(p.items)) rows.push(...p.items)
    return rows
  }, [qLedger.data])

  const detailRows = useMemo(() => {
    return ledgerRaw.map((m: any) => ({
      id: m.id,
      ts: m.ts,
      delta: Number(m.delta || 0),
      reason: m.reason || '',
      ref_type: m.ref_type || '',
      ref_id: m.ref_id ?? '',
      note: m.note || '',
      before: Number(m.balance_before ?? 0),
      after: Number(m.balance_after ?? 0),
    }))
  }, [ledgerRaw])

  // inject extra controls into wrapper header (Pick Item + Reason)
  useEffect(() => {
    setExtraControls(
      <>
        <Button variant="outlined" onClick={() => setItemPickerOpen(true)}>
          {pickedItem ? `Item: ${pickedItem.name} (#${pickedItem.id})` : 'Pick Item'}
        </Button>

        <TextField
          select
          label="Reason"
          value={ledgerReason}
          onChange={(e) => setLedgerReason(e.target.value)}
          sx={{ width: 160 }}
        >
          <MenuItem value="">All</MenuItem>
          <MenuItem value="OPENING">OPENING</MenuItem>
          <MenuItem value="ADJUST">ADJUST</MenuItem>
          <MenuItem value="BILL">BILL</MenuItem>
          <MenuItem value="RETURN">RETURN</MenuItem>
          <MenuItem value="EXCHANGE_IN">EXCHANGE_IN</MenuItem>
          <MenuItem value="EXCHANGE_OUT">EXCHANGE_OUT</MenuItem>
        </TextField>
      </>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedItem, ledgerReason])

  // export
  useEffect(() => {
    setExportDisabled(detailRows.length === 0)
    setExportFn(() => () => {
      const header = ['ID', 'TS', 'Delta', 'Reason', 'Ref Type', 'Ref ID', 'Before', 'After', 'Note']
      const body = detailRows.map((r: any) => [
        String(r.id),
        String(r.ts),
        String(r.delta),
        String(r.reason),
        String(r.ref_type ?? ''),
        String(r.ref_id ?? ''),
        String(r.before ?? ''),
        String(r.after ?? ''),
        String(r.note ?? ''),
      ])
      const csv = toCSV([header, ...body])
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `stock-ledger_${pickedItem?.id ?? 'item'}_${from}_to_${to}.csv`
      a.click()
      URL.revokeObjectURL(url)
    })
  }, [setExportDisabled, setExportFn, detailRows, pickedItem?.id, from, to])

  return (
    <>
      {pickedItem && (
        <Box mt={0} mb={1} color="text.secondary">
          Current Stock:{' '}
          <b>{qLedger.data?.pages?.[0]?.current_stock ?? pickedItem.stock ?? '-'}</b>
        </Box>
      )}

      <Box sx={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>TS</th>
              <th>Delta</th>
              <th>Reason</th>
              <th>Ref</th>
              <th>Before</th>
              <th>After</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {!pickedItem ? (
              <tr>
                <td colSpan={8}>
                  <Box p={2} color="text.secondary">
                    Pick an item to view ledger.
                  </Box>
                </td>
              </tr>
            ) : (
              detailRows.map((r: any) => (
                <tr key={`m-${r.id}`}>
                  <td>{r.id}</td>
                  <td>{r.ts}</td>
                  <td>{r.delta}</td>
                  <td>{r.reason}</td>
                  <td>{r.ref_type ? `${r.ref_type}${r.ref_id ? ` #${r.ref_id}` : ''}` : '-'}</td>
                  <td>{r.before}</td>
                  <td>{r.after}</td>
                  <td>{r.note || '-'}</td>
                </tr>
              ))
            )}

            {pickedItem && detailRows.length === 0 && !qLedger.isLoading && (
              <tr>
                <td colSpan={8}>
                  <Box p={2} color="text.secondary">
                    No ledger rows for this date range.
                  </Box>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Box>

      {qLedger.isLoading && pickedItem && (
        <Box sx={{ py: 2, textAlign: 'center' }}>
          <Typography variant="body2">Loading…</Typography>
        </Box>
      )}

      {qLedger.isError && pickedItem && (
        <Box sx={{ py: 2, textAlign: 'center' }}>
          <Typography variant="body2" color="error">
            Failed to load.
          </Typography>
        </Box>
      )}

      {/* Item Picker dialog */}
      <Dialog open={itemPickerOpen} onClose={() => setItemPickerOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Pick Item
          <IconButton onClick={() => setItemPickerOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent dividers>
          <Stack gap={2}>
            <TextField
              label="Search item (name/brand)"
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              fullWidth
            />

            <Divider />

            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Name</th>
                    <th>Brand</th>
                    <th>Stock</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {qItemSearch.isLoading && (
                    <tr>
                      <td colSpan={5}>
                        <Box p={2} color="text.secondary">
                          Loading…
                        </Box>
                      </td>
                    </tr>
                  )}

                  {!qItemSearch.isLoading && (qItemSearch.data || []).length === 0 && debouncedItemSearch && (
                    <tr>
                      <td colSpan={5}>
                        <Box p={2} color="text.secondary">
                          No items found.
                        </Box>
                      </td>
                    </tr>
                  )}

                  {(qItemSearch.data || []).slice(0, 50).map((it: any) => (
                    <tr key={it.id}>
                      <td>{it.id}</td>
                      <td>{it.name}</td>
                      <td>{it.brand || '-'}</td>
                      <td>{it.stock}</td>
                      <td style={{ width: 100 }}>
                        <Button
                          size="small"
                          variant="contained"
                          onClick={() => {
                            setPickedItem(it)
                            setItemPickerOpen(false)
                          }}
                        >
                          Pick
                        </Button>
                      </td>
                    </tr>
                  ))}

                  {!debouncedItemSearch && (
                    <tr>
                      <td colSpan={5}>
                        <Box p={2} color="text.secondary">
                          Type to search items.
                        </Box>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Box>

            <Typography variant="body2" color="text.secondary">
              Tip: Pick the correct item batch if you have duplicates (same name/brand with different expiry).
            </Typography>
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  )
}
