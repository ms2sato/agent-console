import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen';
import { fetchConfig } from './lib/api';
import { setHomeDir } from './lib/path';
import {
  hasPendingSaves,
  flush as flushSaveManager,
} from './lib/terminal-state-save-manager';
import { setCapabilities } from './lib/capabilities';
import { setCurrentServerPid, cleanupOldStates } from './lib/terminal-state-cache';
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

// Escape HTML special characters to prevent XSS
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Show connection error with retry button
function showConnectionError(error: unknown) {
  const rawErrorMessage = error instanceof Error ? error.message : 'Unknown error';
  // SECURITY: Escape HTML to prevent XSS from error messages
  const errorMessage = escapeHtml(rawErrorMessage);
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
    setCapabilities(config.capabilities);

    // Set current server PID and handle cache invalidation if server has restarted
    // This clears all terminal caches if the server PID has changed
    await setCurrentServerPid(config.serverPid);

    // Clean up expired terminal states (24 hours old)
    // This runs after server PID check, so states from previous servers are already cleared
    cleanupOldStates().catch((e) => {
      console.warn('Failed to cleanup old terminal states:', e);
    });
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

// Best-effort flush of pending terminal state saves on page unload
// Note: Cannot await in beforeunload - this is a best-effort attempt
window.addEventListener('beforeunload', () => {
  if (hasPendingSaves()) {
    flushSaveManager().catch((e) => {
      console.error('[SaveManager] Failed to flush on beforeunload:', e);
    });
  }
});

initApp();
