import api from './api'
import type { VoucherDayBook } from '../lib/types'

export async function fetchVoucherDayBook(params: {
  from_date?: string
  to_date?: string
  voucher_type?: string
  q?: string
  deleted_filter?: 'active' | 'deleted' | 'all'
  include_stock_journal?: boolean
}): Promise<VoucherDayBook> {
  const { data } = await api.get<VoucherDayBook>('/vouchers/daybook', { params })
  return data
}
