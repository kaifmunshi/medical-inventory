import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField, Typography } from '@mui/material'
import { useEffect, useState } from 'react'

export default function AdjustStockDialog({
  open, itemName, onClose, onConfirm
}: {
  open: boolean
  itemName?: string
  onClose: () => void
  onConfirm: (delta: number) => void
}) {
  const [delta, setDelta] = useState<string>('0')
  useEffect(() => { setDelta('0') }, [open])

  const parsedDelta = Number(delta)
  const hasDelta = delta.trim() !== ''
  const canApply = hasDelta && Number.isInteger(parsedDelta)

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Adjust Stock</DialogTitle>
      <DialogContent>
        <Stack gap={1}>
          <Typography variant="body2" color="text.secondary">Item: {itemName}</Typography>
          <TextField
            label="Change by (e.g. -2 or 5)"
            type="number"
            value={delta}
            error={hasDelta && !canApply}
            helperText={hasDelta && !canApply ? 'Enter a whole number' : ' '}
            inputProps={{ step: 1 }}
            onFocus={() => {
              if (delta === '0') setDelta('')
            }}
            onChange={e => setDelta(e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!canApply} onClick={() => onConfirm(parsedDelta)}>Apply</Button>
      </DialogActions>
    </Dialog>
  )
}
