import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { logout as logoutApi } from '../lib/api';
import { setCurrentUser } from '../lib/auth';
import { disconnect as disconnectAppWs } from '../lib/app-websocket';
import { clearStoredFilterMode } from './useSessionFilter';
import { setHomeDir } from '../lib/path';

/** Logs the current user out and clears every piece of client-side per-user state. */
export function useLogout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const logout = async () => {
    setIsLoggingOut(true);
    try {
      await logoutApi();
    } catch {
      // Even if the API call fails, clear local state
    }
    // Clear all client-side state to prevent cross-user data leakage
    disconnectAppWs();
    queryClient.clear();
    clearStoredFilterMode();
    setCurrentUser(null);
    setHomeDir('');
    void navigate({ to: '/login' });
  };

  return { logout, isLoggingOut };
}
