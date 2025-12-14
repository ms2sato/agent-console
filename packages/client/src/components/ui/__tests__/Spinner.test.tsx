import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { Spinner, ButtonSpinner, FormOverlay, LoadingOverlay } from '../Spinner';

describe('Spinner', () => {
  afterEach(() => {
    cleanup();
  });

  describe('Spinner component', () => {
    it('renders with default size (md)', () => {
      render(<Spinner />);

      const spinner = screen.getByRole('status');
      expect(spinner).toBeTruthy();
      expect(spinner.getAttribute('aria-label')).toBe('Loading');
      expect(spinner.className).toContain('w-6');
      expect(spinner.className).toContain('h-6');
    });

    it('renders with small size', () => {
      render(<Spinner size="sm" />);

      const spinner = screen.getByRole('status');
      expect(spinner.className).toContain('w-4');
      expect(spinner.className).toContain('h-4');
    });

    it('renders with large size', () => {
      render(<Spinner size="lg" />);

      const spinner = screen.getByRole('status');
      expect(spinner.className).toContain('w-8');
      expect(spinner.className).toContain('h-8');
    });

    it('applies custom className', () => {
      render(<Spinner className="text-red-500" />);

      const spinner = screen.getByRole('status');
      expect(spinner.className).toContain('text-red-500');
    });

    it('has spin animation class', () => {
      render(<Spinner />);

      const spinner = screen.getByRole('status');
      expect(spinner.className).toContain('animate-spin');
    });
  });

  describe('ButtonSpinner component', () => {
    it('renders children when not pending', () => {
      render(
        <ButtonSpinner isPending={false} pendingText="Loading...">
          Submit
        </ButtonSpinner>
      );

      expect(screen.getByText('Submit')).toBeTruthy();
      expect(screen.queryByText('Loading...')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('renders spinner and pending text when pending', () => {
      render(
        <ButtonSpinner isPending={true} pendingText="Loading...">
          Submit
        </ButtonSpinner>
      );

      expect(screen.getByText('Loading...')).toBeTruthy();
      expect(screen.queryByText('Submit')).toBeNull();
      expect(screen.getByRole('status')).toBeTruthy();
    });
  });

  describe('FormOverlay component', () => {
    it('renders nothing when not visible', () => {
      const { container } = render(<FormOverlay isVisible={false} />);

      expect(container.firstChild).toBeNull();
    });

    it('renders overlay when visible', () => {
      render(<FormOverlay isVisible={true} />);

      const spinner = screen.getByRole('status');
      expect(spinner).toBeTruthy();
    });

    it('renders message when provided', () => {
      render(<FormOverlay isVisible={true} message="Processing..." />);

      expect(screen.getByText('Processing...')).toBeTruthy();
    });

    it('does not render message when not provided', () => {
      render(<FormOverlay isVisible={true} />);

      // Should only have spinner, no text
      expect(screen.queryByText(/./)).toBeNull();
    });

    it('has correct positioning classes', () => {
      const { container } = render(<FormOverlay isVisible={true} message="Test" />);

      const overlay = container.firstChild as HTMLElement;
      expect(overlay.className).toContain('absolute');
      expect(overlay.className).toContain('inset-0');
      expect(overlay.className).toContain('z-10');
    });
  });

  describe('LoadingOverlay component', () => {
    it('renders with default message', () => {
      render(<LoadingOverlay />);

      expect(screen.getByText('Loading...')).toBeTruthy();
      expect(screen.getByRole('status')).toBeTruthy();
    });

    it('renders with custom message', () => {
      render(<LoadingOverlay message="Connecting..." />);

      expect(screen.getByText('Connecting...')).toBeTruthy();
    });

    it('has fixed positioning for full screen', () => {
      const { container } = render(<LoadingOverlay />);

      const overlay = container.firstChild as HTMLElement;
      expect(overlay.className).toContain('fixed');
      expect(overlay.className).toContain('inset-0');
      expect(overlay.className).toContain('z-50');
    });
  });
});
