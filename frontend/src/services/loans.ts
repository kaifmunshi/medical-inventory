import api from './api'

export type LoanAdjustment = { id: number; loan_entry_id: number; loan_book: 'CASH'|'BANK'|'OPENING'; party_id: number; cashbook_entry_id?: number | null; bankbook_entry_id?: number|null; settlement_book?: 'CASH'|'BANK'|null; adjustment_type: 'MONEY' | 'WRITE_OFF' | 'PRODUCT'; amount: number; product_reference?: string | null; note?: string | null; adjusted_at: string }
export type LoanAccount = { loan_entry_id: number; loan_book: 'CASH'|'BANK'|'OPENING'; party_id: number; party_name: string; loan_date: string; principal_amount: number; adjusted_amount: number; outstanding_amount: number; note?: string | null; adjustments: LoanAdjustment[] }

export async function fetchLoans(params?: { party_id?: number; open_only?: boolean }) {
  return (await api.get<LoanAccount[]>('/loans/', { params })).data
}
export async function addLoanAdjustment(book: 'CASH'|'BANK'|'OPENING', loanId: number, payload: { adjustment_type: 'MONEY' | 'WRITE_OFF' | 'PRODUCT'; amount: number; product_reference?: string; note?: string; adjustment_date?: string; settlement_book?: 'CASH'|'BANK'; bank_mode?: string }) {
  return (await api.post<LoanAccount>(`/loans/${book}/${loanId}/adjustments`, payload)).data
}
export async function deleteLoanAdjustment(id: number) { return (await api.delete(`/loans/adjustments/${id}`)).data }
export async function fetchLoanAdjustmentByEntry(book:'CASH'|'BANK',entryId:number) { return (await api.get<LoanAdjustment>('/loans/adjustment-by-entry',{params:{book,entry_id:entryId}})).data }
export async function updateLoanAdjustment(id:number,payload:{adjustment_type:'MONEY';amount:number;adjustment_date:string;note?:string;settlement_book:'CASH'|'BANK';party_id:number;target_loan_book:'CASH'|'BANK'|'OPENING';target_loan_entry_id:number}) { return (await api.patch<LoanAccount>(`/loans/adjustments/${id}`,payload)).data }
export type LoanCandidate = { book:'CASH'|'BANK'; entry_id:number; entry_type:string; date:string; amount:number; note?:string|null; suggested_role:'DISBURSEMENT'|'REPAYMENT' }
export async function fetchLoanCandidates() { return (await api.get<LoanCandidate[]>('/loans/reconciliation-candidates')).data }
export async function reconcileLoanEntry(payload:{book:'CASH'|'BANK';entry_id:number;role:'DISBURSEMENT'|'REPAYMENT';party_id:number;target_loan_book?:'CASH'|'BANK'|'OPENING';target_loan_entry_id?:number;amount?:number;entry_date?:string;note?:string;create_opening_amount?:number;create_opening_date?:string}) { return (await api.post('/loans/reconcile',payload)).data }
export async function createOpeningLoan(payload:{party_id:number;opening_date:string;amount:number;note?:string}) { return (await api.post<LoanAccount>('/loans/opening',payload)).data }
export async function createOpeningLoanWithReturn(payload:{party_id:number;opening_date:string;opening_amount:number;return_date:string;return_amount:number;settlement_book:'CASH'|'BANK';bank_mode?:string;note?:string}) { return (await api.post<LoanAccount>('/loans/opening-with-return',payload)).data }
