import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Dashboard } from './dash/Dashboard';
import './styles.css';

// /dasbor = dasbor penjual & sponsor (akun PaceTara biasa); selain itu panel super admin (kata sandi + TOTP).
const isDashboard = window.location.pathname.replace(/\/+$/, '') === '/dasbor';

createRoot(document.getElementById('root')!).render(<StrictMode>{isDashboard ? <Dashboard /> : <App />}</StrictMode>);
