import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreviewPanel } from '../PreviewPanel';

describe('PreviewPanel', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let createObjectURL: ReturnType<typeof mock>;
  let revokeObjectURL: ReturnType<typeof mock>;
  let blobUrlCounter = 0;

  beforeEach(() => {
    blobUrlCounter = 0;
    createObjectURL = mock(() => `blob:mock-${blobUrlCounter++}`);
    revokeObjectURL = mock(() => {});
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    cleanup();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('is collapsed by default -- no <iframe> in the DOM on initial render', () => {
    const { container } = render(<PreviewPanel code="<div>hi</div>" lang="html" />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not mount the iframe until the user clicks Preview (lazy mount / never-parsed-before-opt-in)', async () => {
    const user = userEvent.setup();
    const { container } = render(<PreviewPanel code="<div>hi</div>" lang="html" />);

    expect(container.querySelector('iframe')).toBeNull();

    await user.click(screen.getByText('Preview'));

    expect(container.querySelector('iframe')).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('renders the iframe with sandbox="" (empty, no tokens) once expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(<PreviewPanel code="<div>hi</div>" lang="html" />);
    await user.click(screen.getByText('Preview'));

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('sandbox')).toBe('');
  });

  it('renders the iframe with referrerpolicy="no-referrer" once expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(<PreviewPanel code="<div>hi</div>" lang="html" />);
    await user.click(screen.getByText('Preview'));

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('revokes the blob URL on unmount', async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<PreviewPanel code="<div>hi</div>" lang="html" />);
    await user.click(screen.getByText('Preview'));
    const iframe = container.querySelector('iframe');
    const src = iframe?.getAttribute('src');

    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith(src);
  });

  it('revokes the previous blob URL and creates a fresh one when `code` changes while expanded (content-change leak guard)', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<PreviewPanel code="<div>one</div>" lang="html" />);
    await user.click(screen.getByText('Preview'));
    const firstSrc = container.querySelector('iframe')?.getAttribute('src');
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    rerender(<PreviewPanel code="<div>two</div>" lang="html" />);

    expect(revokeObjectURL).toHaveBeenCalledWith(firstSrc);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    const secondSrc = container.querySelector('iframe')?.getAttribute('src');
    expect(secondSrc).not.toBe(firstSrc);
  });

  it('revokes the blob URL when collapsing back to Code', async () => {
    const user = userEvent.setup();
    const { container } = render(<PreviewPanel code="<div>hi</div>" lang="html" />);
    await user.click(screen.getByText('Preview'));
    const src = container.querySelector('iframe')?.getAttribute('src');

    await user.click(screen.getByText('Code'));

    expect(container.querySelector('iframe')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith(src);
  });
});
