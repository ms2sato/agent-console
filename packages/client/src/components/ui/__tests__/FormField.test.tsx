import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import type { FieldError } from 'react-hook-form';
import { FormField } from '../FormField';

const longUrl = `https://example.com/${'a'.repeat(180)}`;

describe('FormField', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders label and children', () => {
    render(
      <FormField label="Name">
        <input />
      </FormField>
    );

    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('renders the error alert with break-words so long URLs wrap', () => {
    render(
      <FormField error={{ message: longUrl } as FieldError}>
        <input />
      </FormField>
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(longUrl);
    expect(alert.className).toContain('break-words');
  });
});
