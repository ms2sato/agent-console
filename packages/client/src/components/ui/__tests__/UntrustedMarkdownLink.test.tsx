import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { UntrustedLink, untrustedUrlTransform } from '../UntrustedMarkdownLink';

afterEach(() => {
  cleanup();
});

describe('untrustedUrlTransform', () => {
  it('keeps absolute http and https URLs unchanged', () => {
    expect(untrustedUrlTransform('https://example.com/a?q=1#f')).toBe('https://example.com/a?q=1#f');
    expect(untrustedUrlTransform('http://localhost:3457/x')).toBe('http://localhost:3457/x');
  });

  it('drops every other scheme, relative paths, fragments and the empty string', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.example', 'file:///etc/passwd', '../x', '/x', '#frag', '']) {
      expect(untrustedUrlTransform(url)).toBe('');
    }
  });
});

describe('UntrustedLink', () => {
  it('renders an anchor with target=_blank and rel=noopener noreferrer followed by the real host', () => {
    const { container } = render(<UntrustedLink href="https://hostile.example/x">something trustworthy</UntrustedLink>);

    const link = screen.getByRole('link', { name: 'something trustworthy' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toBe('something trustworthy (hostile.example)');
  });

  it('adds no suffix when the visible text is the URL, the URL without a trailing slash, or the host', () => {
    for (const [href, text] of [
      ['https://example.com/a', 'https://example.com/a'],
      ['https://example.com/', 'https://example.com'],
      ['https://example.com/a', 'example.com'],
    ]) {
      const { container, unmount } = render(<UntrustedLink href={href}>{text}</UntrustedLink>);
      expect(container.textContent).toBe(text);
      unmount();
    }
  });

  it('reads nested element children when deciding whether the text is the host', () => {
    const { container } = render(<UntrustedLink href="https://example.com/a"><strong>example.com</strong></UntrustedLink>);

    expect(container.textContent).toBe('example.com');
  });

  it('renders plain text without an anchor when there is no href', () => {
    const { container } = render(<UntrustedLink>just text</UntrustedLink>);

    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('just text');
  });

  it('passes tabIndex through to the anchor', () => {
    render(<UntrustedLink href="https://example.com/a" tabIndex={-1}>t</UntrustedLink>);

    expect(screen.getByRole('link', { name: 't' }).getAttribute('tabindex')).toBe('-1');
  });
});
