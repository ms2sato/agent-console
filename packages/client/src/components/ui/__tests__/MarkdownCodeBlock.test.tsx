import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import Markdown from 'react-markdown';
import { waitForAbsent } from '../../../test/waitForAbsent';
import { MarkdownCodeBlock, codeBlockCopyText } from '../MarkdownCodeBlock';

// The clipboard is faked at the navigator boundary (not by mocking lib/clipboard,
// which other test files import for real): happy-dom's clipboard is swapped for a
// spy, and `isSecureContext` is forced true so `copyToClipboard` takes the modern path.
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'clipboard');
const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
let writeText: ReturnType<typeof mock<(text: string) => Promise<void>>>;

beforeEach(() => {
  writeText = mock(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, writable: true, configurable: true });
  Object.defineProperty(window, 'isSecureContext', { value: true, writable: true, configurable: true });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
  if (originalClipboardDescriptor && !('clipboard' in navigator)) {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'clipboard', originalClipboardDescriptor);
  }
  if (originalIsSecureContext) {
    Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
  } else {
    Reflect.deleteProperty(window, 'isSecureContext');
  }
});

/** The same routing MemoPanel uses: fenced blocks (`pre`) go to MarkdownCodeBlock, inline `code` is untouched. */
function MemoLike({ source }: { source: string }) {
  return <Markdown components={{ pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock> }}>{source}</Markdown>;
}

const LONG_ONE_LINE_COMMAND = `curl -s https://example.com/api/${'segment-'.repeat(36)}end --header 'X-Token: abc' | jq .`;
const THREE_LINE_SCRIPT = ['set -e', 'cd /tmp/work', 'bun run build'].join('\n');

describe('codeBlockCopyText', () => {
  it('removes exactly the one trailing newline and nothing else', () => {
    expect(codeBlockCopyText('ls -la\n')).toBe('ls -la');
    expect(codeBlockCopyText('ls -la')).toBe('ls -la');
    expect(codeBlockCopyText('a\n\n')).toBe('a\n');
    expect(codeBlockCopyText('  indented $ prompt-looking\n')).toBe('  indented $ prompt-looking');
    expect(codeBlockCopyText('')).toBe('');
  });
});

describe('MarkdownCodeBlock', () => {
  it('renders the code text with the language class react-markdown passes, and a Copy control', () => {
    render(<MemoLike source={'```bash\nls -la\n```'} />);

    const block = screen.getByTestId('markdown-code-block');
    expect(block.querySelector('pre > code')?.textContent).toBe('ls -la\n');
    expect(block.querySelector('code')?.className).toBe('language-bash');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });

  it('copies a 300-char single-line command EXACTLY (no inserted line break)', async () => {
    expect(LONG_ONE_LINE_COMMAND.length).toBeGreaterThan(300);
    render(<MemoLike source={['```', LONG_ONE_LINE_COMMAND, '```'].join('\n')} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe(LONG_ONE_LINE_COMMAND);
    expect(writeText.mock.calls[0][0]).not.toContain('\n');
  });

  it('copies a 3-line script EXACTLY, keeping its own line breaks and trimming only the trailing newline', async () => {
    render(<MemoLike source={['```sh', THREE_LINE_SCRIPT, '```'].join('\n')} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });

    expect(writeText.mock.calls[0][0]).toBe(THREE_LINE_SCRIPT);
  });

  it('copies each block\'s own text when a memo has several', async () => {
    render(<MemoLike source={['```', 'first cmd', '```', '', '```', 'second cmd', '```'].join('\n')} />);

    const buttons = screen.getAllByRole('button', { name: 'Copy code' });
    expect(buttons).toHaveLength(2);
    await act(async () => {
      fireEvent.click(buttons[1]);
    });

    expect(writeText.mock.calls[0][0]).toBe('second cmd');
  });

  it('renders inline code without any Copy control', () => {
    render(<MemoLike source={'Run `ls -la` then stop.'} />);

    expect(screen.queryByTestId('markdown-code-block')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull();
    expect(screen.getByText('ls -la').tagName).toBe('CODE');
  });

  it('shows "Copied!" after a copy and reverts to the icon after about 1.5 seconds', async () => {
    render(<MemoLike source={'```\nls\n```'} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(screen.getByText('Copied!')).toBeTruthy();

    await waitForAbsent(() => screen.queryByText('Copied!'), { timeout: 2500 });
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });

  it('leaves the label unchanged when the copy fails', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('denied')));
    // The modern API failing falls through to execCommand, which happy-dom does not support: both fail.
    render(<MemoLike source={'```\nls\n```'} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });

    expect(screen.queryByText('Copied!')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });
});
