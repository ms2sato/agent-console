import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockNavigate = mock(() => {});
mock.module('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

import { renderHook } from '@testing-library/react';
import { useWorkerRouting } from '../useWorkerRouting';

describe('useWorkerRouting', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  describe('navigateToWorker', () => {
    it('calls navigate with correct params', () => {
      const { result } = renderHook(() => useWorkerRouting('session-1'));

      result.current.navigateToWorker('worker-1');

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/sessions/$sessionId/$workerId',
        params: { sessionId: 'session-1', workerId: 'worker-1' },
        replace: false,
      });
    });

    it('passes replace flag when replace is true', () => {
      const { result } = renderHook(() => useWorkerRouting('session-1'));

      result.current.navigateToWorker('worker-1', true);

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/sessions/$sessionId/$workerId',
        params: { sessionId: 'session-1', workerId: 'worker-1' },
        replace: true,
      });
    });
  });

  describe('navigateToSession', () => {
    it('calls navigate with correct params and replace: true', () => {
      const { result } = renderHook(() => useWorkerRouting('session-1'));

      result.current.navigateToSession();

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/sessions/$sessionId',
        params: { sessionId: 'session-1' },
        replace: true,
      });
    });
  });

  describe('reference stability', () => {
    it('returns stable function references when sessionId does not change', () => {
      const { result, rerender } = renderHook(() => useWorkerRouting('session-1'));

      const firstNavigateToWorker = result.current.navigateToWorker;
      const firstNavigateToSession = result.current.navigateToSession;

      rerender();

      expect(result.current.navigateToWorker).toBe(firstNavigateToWorker);
      expect(result.current.navigateToSession).toBe(firstNavigateToSession);
    });
  });
});
