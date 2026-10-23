import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import '../styles/index.css';
import './app.css';

document.querySelectorAll<HTMLLinkElement>('link[data-font]').forEach(link => {
  link.media = 'all';
});
const queryClient = new QueryClient();

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
