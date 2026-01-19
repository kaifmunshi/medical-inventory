// F:\medical-inventory\frontend\src\lib\billing.ts
export type PaymentMode = 'cash'|'online'|'split'|'credit'


export function computeTotals(rows: { quantity:number; mrp:number }[], discount_percent:number, tax_percent:number){
const subtotal = rows.reduce((s,r)=> s + r.quantity*r.mrp, 0)
const discount = subtotal * (discount_percent/100)
const afterDiscount = subtotal - discount
const tax = afterDiscount * (tax_percent/100)
const total = Math.round((afterDiscount + tax) * 100) / 100
return { subtotal, discount, tax, total }
}


export function validatePayments(mode: PaymentMode, total:number, cash?:number, online?:number){
const to2 = (v:number)=> Math.round(v*100)/100
if(mode==='credit') return true
if(mode==='cash') return to2(cash||0)===to2(total)
if(mode==='online') return to2(online||0)===to2(total)
if(mode==='split') return to2((cash||0)+(online||0))===to2(total)
return false
}
