import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';

export function useWorkerRouting(sessionId: string) {
  const navigate = useNavigate();

  const navigateToWorker = useCallback((workerId: string, replace: boolean = false) => {
    navigate({
      to: '/sessions/$sessionId/$workerId',
      params: { sessionId, workerId },
      replace,
    });
  }, [navigate, sessionId]);

  const navigateToSession = useCallback(() => {
    navigate({
      to: '/sessions/$sessionId',
      params: { sessionId },
      replace: true,
    });
  }, [navigate, sessionId]);

  return { navigateToWorker, navigateToSession };
}
