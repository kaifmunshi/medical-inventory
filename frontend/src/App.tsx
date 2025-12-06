// frontend\src\App.tsx
import AppRoutes from './routes';
import Toaster from './components/ui/Toaster';

export default function App() {
  return (
    <Toaster>
      <AppRoutes />
    </Toaster>
  );
}
