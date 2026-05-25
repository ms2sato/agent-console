import { describe, it, expect, afterEach } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import { PageErrorFallback } from '../PageErrorFallback';
import { renderWithRouter } from '../../test/renderWithRouter';

const longUrl = `https://example.com/${'a'.repeat(180)}`;

describe('PageErrorFallback', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the error.message paragraph with break-words so long URLs wrap', async () => {
    await renderWithRouter(
      <PageErrorFallback
        error={new Error(longUrl)}
        reset={() => {}}
        breadcrumbItems={[]}
        errorMessage="something failed"
        backTo="/"
        backLabel="Back"
      />
    );

    const messageEl = screen.getByText(longUrl);
    expect(messageEl.className).toContain('break-words');
  });
});
