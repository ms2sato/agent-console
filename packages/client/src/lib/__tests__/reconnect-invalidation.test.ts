import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerReconnectInvalidation,
  listReconnectInvalidationKeys,
  _resetReconnectInvalidation,
} from '../reconnect-invalidation';

beforeEach(() => {
  _resetReconnectInvalidation();
});

describe('reconnect invalidation registry', () => {
  it('starts empty (the vacuous case)', () => {
    expect(listReconnectInvalidationKeys()).toEqual([]);
  });

  it('registering the same key twice keeps one entry, also when it arrives as a new array each time', () => {
    registerReconnectInvalidation([['todos']]);
    registerReconnectInvalidation([['todos']]);
    registerReconnectInvalidation([['todos'], ['todos']]);

    expect(listReconnectInvalidationKeys()).toEqual([['todos']]);
  });

  it('two different keys are two entries, listed by value', () => {
    registerReconnectInvalidation([['todos'], ['artifacts']]);

    expect(listReconnectInvalidationKeys()).toEqual([['todos'], ['artifacts']]);
  });

  it('a key that is a prefix of another is a separate entry', () => {
    registerReconnectInvalidation([['todos'], ['todos', 'list']]);

    expect(listReconnectInvalidationKeys()).toHaveLength(2);
  });

  it('reset empties it', () => {
    registerReconnectInvalidation([['todos']]);
    _resetReconnectInvalidation();

    expect(listReconnectInvalidationKeys()).toEqual([]);
  });
});
