import { describe, it, expect, afterEach, mock } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { SCHEMA_VERSION } from '@agent-console/shared';
import { SchemaVersionBanner } from '../SchemaVersionBanner';
import {
  checkServerSchemaVersion,
  _reset,
  _setReloadImpl,
  _simulateReload,
} from '../../../lib/schema-version';

const STALE_SERVER_VERSION = `${SCHEMA_VERSION}-stale`;

/**
 * Drive the module into the degraded "mismatch persists after reload" state
 * through the production path (first mismatch reloads; the second, after the
 * reload boundary, sets the mismatch flag without reloading again).
 */
function enterMismatchState() {
  _setReloadImpl(mock(() => {}));
  checkServerSchemaVersion(STALE_SERVER_VERSION);
  _simulateReload();
  checkServerSchemaVersion(STALE_SERVER_VERSION);
}

describe('SchemaVersionBanner', () => {
  afterEach(() => {
    cleanup();
    _reset();
  });

  it('does not render when there is no schema-version mismatch', () => {
    _reset();

    const { container } = render(<SchemaVersionBanner />);

    expect(container.firstChild).toBeNull();
  });

  it('renders an alert prompting a manual refresh when the mismatch persists', () => {
    _reset();
    enterMismatchState();

    render(<SchemaVersionBanner />);

    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain('refresh the page');
  });
});
