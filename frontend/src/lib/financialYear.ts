import type { FinancialYear } from './types'

export function financialYearLabelFromDates(startDate?: string | null, endDate?: string | null) {
  const start = String(startDate || '')
  const end = String(endDate || '')
  const startYear = Number(start.slice(0, 4))
  const endYear = Number(end.slice(0, 4))
  const isAprilStart = start.slice(5, 10) === '04-01'
  const isMarchEnd = end.slice(5, 10) === '03-31'

  if (Number.isFinite(startYear) && Number.isFinite(endYear) && isAprilStart && isMarchEnd) {
    return `FY ${startYear}-${String(endYear).slice(-2)}`
  }

  const fallbackYear = Number.isFinite(startYear) ? startYear : new Date().getFullYear()
  return `FY ${fallbackYear}-${String(fallbackYear + 1).slice(-2)}`
}

export function financialYearDisplayName(year: FinancialYear) {
  return financialYearLabelFromDates(year.start_date, year.end_date)
}

export function financialYearRange(year: FinancialYear) {
  return `${year.start_date} to ${year.end_date}`
}
