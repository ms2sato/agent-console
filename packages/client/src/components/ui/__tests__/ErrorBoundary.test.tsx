import { describe, it, expect, mock, afterEach, spyOn } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

// Component that throws an error
function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Test error message');
  }
  return <div>Normal content</div>;
}

describe('ErrorBoundary', () => {
  // Suppress console.error during tests since we expect errors
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    cleanup();
    consoleErrorSpy?.mockRestore();
  });

  it('renders children when there is no error', () => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <div>Test content</div>
      </ErrorBoundary>
    );

    expect(screen.getByText('Test content')).toBeTruthy();
  });

  it('renders default fallback UI when child throws an error', () => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('Test error message')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });

  it('renders custom fallback ReactNode when provided', () => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={<div>Custom error UI</div>}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Custom error UI')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('renders custom fallback function with error and resetError', () => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const fallbackFn = mock((error: Error, resetError: () => void) => (
      <div>
        <span>Error: {error.message}</span>
        <button onClick={resetError}>Reset</button>
      </div>
    ));

    render(
      <ErrorBoundary fallback={fallbackFn}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(fallbackFn).toHaveBeenCalled();
    expect(screen.getByText('Error: Test error message')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy();
  });

  it('calls onError callback when error is caught', () => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onError = mock((_error: any, _errorInfo: any) => {});

    render(
      <ErrorBoundary onError={onError}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, errorInfo] = onError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Test error message');
    expect(errorInfo).toHaveProperty('componentStack');
  });

  it('resets error state when resetError is called and component no longer throws', () => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    // Use a controllable throw flag
    let shouldThrow = true;

    function ConditionalThrow() {
      if (shouldThrow) {
        throw new Error('Conditional error');
      }
      return <div>Recovered content</div>;
    }

    const { rerender } = render(
      <ErrorBoundary
        fallback={(_error, resetError) => (
          <div>
            <span>Error occurred</span>
            <button onClick={resetError}>Reset</button>
          </div>
        )}
      >
        <ConditionalThrow />
      </ErrorBoundary>
    );

    // Should show error state
    expect(screen.getByText('Error occurred')).toBeTruthy();

    // Change the flag so component won't throw on next render
    shouldThrow = false;

    // Click reset button - this clears the error state
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    // Force re-render to pick up the state change
    rerender(
      <ErrorBoundary
        fallback={(_error, resetError) => (
          <div>
            <span>Error occurred</span>
            <button onClick={resetError}>Reset</button>
          </div>
        )}
      >
        <ConditionalThrow />
      </ErrorBoundary>
    );

    // Should show recovered content
    expect(screen.getByText('Recovered content')).toBeTruthy();
    expect(screen.queryByText('Error occurred')).toBeNull();
  });

  it('catches errors in nested components', () => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <div>
          <div>
            <ThrowingComponent shouldThrow={true} />
          </div>
        </div>
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('isolates errors - sibling ErrorBoundaries do not affect each other', () => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div>
        <ErrorBoundary>
          <ThrowingComponent shouldThrow={true} />
        </ErrorBoundary>
        <ErrorBoundary>
          <div>Sibling content</div>
        </ErrorBoundary>
      </div>
    );

    // First boundary should show error
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    // Second boundary should show normal content
    expect(screen.getByText('Sibling content')).toBeTruthy();
  });

  it('logs error to console', () => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
