import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from '@/data/store';
import AuthGate from '@/components/auth/AuthGate';
import App from './App';
import './styles/index.css';

// Live mode: AuthGate shows sign-in until an active staff member is signed in, then hands over the user.
// Demo mode: it renders straight through with user = null.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate>
      {(user) => (
        <StoreProvider key={user?.id ?? 'demo'} userId={user?.id}>
          <App />
        </StoreProvider>
      )}
    </AuthGate>
  </StrictMode>,
);
