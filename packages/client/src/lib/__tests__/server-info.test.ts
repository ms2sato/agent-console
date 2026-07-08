import { describe, it, expect, beforeEach } from 'bun:test';
import { setServerPort, getServerPort, _reset } from '../server-info';

describe('server-info', () => {
  beforeEach(() => {
    _reset();
  });

  it('should return null before setServerPort is called', () => {
    expect(getServerPort()).toBeNull();
  });

  it('should return the port set via setServerPort', () => {
    setServerPort(3457);
    expect(getServerPort()).toBe(3457);
  });

  it('should overwrite the previous value on repeated setServerPort', () => {
    setServerPort(3457);
    setServerPort(6340);
    expect(getServerPort()).toBe(6340);
  });

  it('should reset back to null via _reset', () => {
    setServerPort(3457);
    _reset();
    expect(getServerPort()).toBeNull();
  });
});
