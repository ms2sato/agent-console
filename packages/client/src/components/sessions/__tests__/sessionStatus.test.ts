import { describe, it, expect } from 'bun:test';
import { getConnectionStatusColor, getConnectionStatusText } from '../sessionStatus';

const exitInfo = { code: 1, signal: null };

describe('Session status helpers', () => {
  it('returns green/Connected for terminal when connected and activity unknown', () => {
    expect(getConnectionStatusColor('connected', 'unknown', 'terminal')).toBe('bg-green-500');
    expect(getConnectionStatusText('connected', 'unknown', null, 'terminal')).toBe('Connected');
  });

  it('keeps agent starting text when connected and activity unknown', () => {
    expect(getConnectionStatusText('connected', 'unknown', null, 'agent')).toBe('Starting Claude...');
  });

  it('uses non-agent color rules for git-diff', () => {
    expect(getConnectionStatusColor('connecting', 'unknown', 'git-diff')).toBe('bg-yellow-500');
    expect(getConnectionStatusColor('disconnected', 'unknown', 'git-diff')).toBe('bg-gray-500');
  });

  it('renders exit details regardless of worker type', () => {
    expect(getConnectionStatusText('exited', 'idle', exitInfo, 'terminal')).toBe('Exited (code: 1)');
  });
});
