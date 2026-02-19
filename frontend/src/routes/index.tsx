// frontend/src/routes/index.tsx
import { Route, Routes, Navigate } from 'react-router-dom'
import AppLayout from '../components/layout/AppLayout'
import Dashboard from '../pages/Dashboard'
import Inventory from '../pages/Inventory'
import Billing from '../pages/Billing'
import Returns from '../pages/Returns'
import Exchange from '../pages/Returns/Exchange'
import Reports from '../pages/Reports/index'
import Settings from '../pages/Settings'
import RequestedItems from '../pages/RequestedItems/index'
import CreditBills from '../pages/CreditBills' // ✅ NEW
import CashbookPage from '../pages/Cashbook'
import SalesBookPage from '../pages/SalesBook'

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="billing" element={<Billing />} />
        <Route path="returns" element={<Returns />} />
        <Route path="exchange" element={<Exchange />} />
        <Route path="reports" element={<Reports />} />
        <Route path="credit-bills" element={<CreditBills />} /> {/* ✅ NEW */}
        <Route path="cashbook" element={<CashbookPage />} />
        <Route path="sales-book" element={<SalesBookPage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="requested-items" element={<RequestedItems />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
