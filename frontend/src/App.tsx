// frontend\src\App.tsx
import AppRoutes from './routes';
import Toaster from './components/ui/Toaster';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { UserSessionProvider } from './components/session/UserSessionProvider';

export default function App() {
  return (
    <ErrorBoundary>
      <Toaster>
        <UserSessionProvider>
          <AppRoutes />
        </UserSessionProvider>
      </Toaster>
    </ErrorBoundary>
  );
}
