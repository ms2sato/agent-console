import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen';
import { fetchConfig } from './lib/api';
import { setHomeDir } from './lib/path';
import './styles.css';

// Create a new router instance
const router = createRouter({ routeTree });

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Create a QueryClient instance
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1 minute
      retry: 1,
    },
  },
});

const rootElement = document.getElementById('root')!;

// Show initial loading indicator
function showLoadingIndicator() {
  rootElement.innerHTML = `
    <div style="
      position: fixed;
      inset: 0;
      background-color: #0a0a14;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    ">
      <div style="
        width: 32px;
        height: 32px;
        border: 3px solid #6366f1;
        border-right-color: transparent;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      "></div>
      <p style="margin-top: 16px; color: #9ca3af;">Connecting to server...</p>
      <style>
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      </style>
    </div>
  `;
}

// Show connection error with retry button
function showConnectionError(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  rootElement.innerHTML = `
    <div style="
      position: fixed;
      inset: 0;
      background-color: #0a0a14;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    ">
      <div style="
        color: #ef4444;
        font-size: 48px;
        margin-bottom: 16px;
      ">⚠</div>
      <h1 style="
        color: #e5e7eb;
        font-size: 20px;
        font-weight: 600;
        margin-bottom: 8px;
      ">Failed to connect to server</h1>
      <p style="
        color: #9ca3af;
        font-size: 14px;
        margin-bottom: 24px;
        text-align: center;
      ">${errorMessage}</p>
      <button
        id="retry-button"
        style="
          background-color: #4338ca;
          color: white;
          padding: 8px 16px;
          border-radius: 4px;
          border: none;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 150ms ease;
        "
        onmouseover="this.style.backgroundColor='#4f46e5'"
        onmouseout="this.style.backgroundColor='#4338ca'"
      >Retry</button>
    </div>
  `;
  document.getElementById('retry-button')?.addEventListener('click', initApp);
}

// Initialize app with config from server
async function initApp() {
  showLoadingIndicator();

  try {
    const config = await fetchConfig();
    setHomeDir(config.homeDir);
  } catch (e) {
    console.error('Failed to fetch config:', e);
    showConnectionError(e);
    return;
  }

  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  );
}

initApp();
