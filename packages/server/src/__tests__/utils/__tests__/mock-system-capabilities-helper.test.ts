import { describe, it, expect } from 'bun:test';
import { createMockSystemCapabilities } from '../mock-system-capabilities-helper.js';

describe('createMockSystemCapabilities', () => {
  it('defaults to no capabilities detected', () => {
    const service = createMockSystemCapabilities();

    expect(service.getCapabilities()).toEqual({
      vscode: false,
      vscodeOpenMode: 'local-spawn',
      vscodeRemoteHost: null,
    });
    expect(service.getVSCodeCommand()).toBeNull();
    expect(Reflect.get(service, 'vscodeCommand')).toBeNull();
  });

  it('defaults vscodeCommand to "code" when vscode is enabled', () => {
    const service = createMockSystemCapabilities({ vscode: true });

    expect(service.getCapabilities()).toEqual({
      vscode: true,
      vscodeOpenMode: 'local-spawn',
      vscodeRemoteHost: null,
    });
    expect(service.getVSCodeCommand()).toBe('code');
    expect(Reflect.get(service, 'vscodeCommand')).toBe('code');
  });

  it('applies an explicit full override of all options', () => {
    const service = createMockSystemCapabilities({
      vscode: true,
      vscodeOpenMode: 'remote-url-scheme',
      vscodeRemoteHost: 'example.com',
      vscodeCommand: 'code-insiders',
    });

    expect(service.getCapabilities()).toEqual({
      vscode: true,
      vscodeOpenMode: 'remote-url-scheme',
      vscodeRemoteHost: 'example.com',
    });
    expect(service.getVSCodeCommand()).toBe('code-insiders');
    expect(Reflect.get(service, 'vscodeCommand')).toBe('code-insiders');
  });
});
