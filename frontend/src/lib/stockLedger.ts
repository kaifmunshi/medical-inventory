export function formatLedgerNote(note?: string | null) {
  const raw = String(note || '').trim()
  if (!raw) return ''

  const legacyReconMatch = raw.match(
    /^Ledger reconciliation gap fill:\s*current_stock=([-+]?\d+),\s*projected_ledger_total=([-+]?\d+)$/i,
  )
  if (legacyReconMatch) {
    const stock = legacyReconMatch[1]
    const ledger = legacyReconMatch[2]
    return `Reconciliation adjustment to align ledger with stock. Stock was ${stock}, ledger was ${ledger} before repair.`
  }

  const legacyBackfillMatch = raw.match(/^Ledger backfill:\s*(.+)$/i)
  if (legacyBackfillMatch) {
    return `Backfilled from source: ${legacyBackfillMatch[1].trim()}`
  }

  return raw
}
