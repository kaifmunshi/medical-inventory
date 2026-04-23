// frontend\src\App.tsx
import AppRoutes from './routes';
import Toaster from './components/ui/Toaster';
import { UserSessionProvider } from './components/session/UserSessionProvider';

export default function App() {
  return (
    <Toaster>
      <UserSessionProvider>
        <AppRoutes />
      </UserSessionProvider>
    </Toaster>
  );
}
