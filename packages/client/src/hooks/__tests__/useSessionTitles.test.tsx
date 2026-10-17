import { describe, it, expect } from 'bun:test';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Session } from '@agent-console/shared';
import { makeSession, SessionDataProvider } from '../../test/session-data';
import { useSessionTitles } from '../useSessionTitles';

function renderTitles(sessions: Session[]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SessionDataProvider sessions={sessions}>{children}</SessionDataProvider>
  );
  return renderHook(() => useSessionTitles(), { wrapper });
}

describe('useSessionTitles', () => {
  it('returns the session list from context', () => {
    const sessions = [makeSession({ id: 'a' }), makeSession({ id: 'b' })];

    const { result } = renderTitles(sessions);

    expect(result.current.sessions).toEqual(sessions);
  });

  it('titleOf returns the session title', () => {
    const { result } = renderTitles([makeSession({ id: 'a', title: 'Release prep' })]);

    expect(result.current.titleOf('a')).toBe('Release prep');
  });

  it('titleOf is null for a session without a title', () => {
    const { result } = renderTitles([makeSession({ id: 'a' })]);

    expect(result.current.titleOf('a')).toBeNull();
  });

  it('titleOf is null for an unknown session', () => {
    const { result } = renderTitles([makeSession({ id: 'a', title: 'Release prep' })]);

    expect(result.current.titleOf('nope')).toBeNull();
  });
});
