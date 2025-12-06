import { Dialog, DialogActions, DialogContent, DialogTitle, Button } from '@mui/material'


export default function ConfirmDialog({ open, title, children, onClose, onConfirm }: any) {
return (
<Dialog open={open} onClose={() => onClose?.()} fullWidth maxWidth="xs">
<DialogTitle>{title || 'Confirm'}</DialogTitle>
<DialogContent>{children}</DialogContent>
<DialogActions>
<Button onClick={onClose}>Cancel</Button>
<Button onClick={onConfirm} variant="contained">Confirm</Button>
</DialogActions>
</Dialog>
)
}