import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ContextUsageBar } from '../ContextUsageBar';
import type { EmbeddedAgentContextUsage } from '../embedded-agent-store';

afterEach(() => {
  cleanup();
});

describe('ContextUsageBar', () => {
  describe('contextWindowTokens defined (determinate)', () => {
    it('renders role="progressbar" with aria-valuenow/min/max reflecting the usage ratio', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={1000}
          contextUsage={{ promptTokens: 300, estimated: false }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBe('30');
      expect(bar.getAttribute('aria-valuemin')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('100');
    });

    it('sizes the fill div width to the usage percentage', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={1000}
          contextUsage={{ promptTokens: 300, estimated: false }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      const fill = bar.querySelector('div');
      expect(fill).not.toBeNull();
      expect(fill?.style.width).toBe('30%');
    });

    it('colors the fill gray below the soft threshold', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={1000}
          contextUsage={{ promptTokens: 300, estimated: false }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.querySelector('div')?.className).toContain('bg-gray-500');
    });

    it('colors the fill amber between the soft and hard thresholds', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={1000}
          contextUsage={{ promptTokens: 600, estimated: false }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.querySelector('div')?.className).toContain('bg-amber-500');
    });

    it('colors the fill red at or above the hard threshold', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={1000}
          contextUsage={{ promptTokens: 900, estimated: false }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.querySelector('div')?.className).toContain('bg-red-600');
    });

    it('colors the fill red exactly at the hard threshold boundary (ratio >= hardRatio)', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={1000}
          contextUsage={{ promptTokens: 800, estimated: false }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.querySelector('div')?.className).toContain('bg-red-600');
    });

    it('shows a hover tooltip with rounded percentage and raw token counts, with no estimate indicator when the reading is provider-reported (estimated: false)', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={1000}
          contextUsage={{ promptTokens: 300, estimated: false }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('title')).toBe('30% (300 / 1000 tokens)');
    });

    it('shows a leading ~ and a trailing "; estimated" clause in the tooltip when the reading is the chars/4 fallback (estimated: true)', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={1000}
          contextUsage={{ promptTokens: 300, estimated: true }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('title')).toBe('~30% (300 / 1000 tokens; estimated)');
    });

    it('renders without a fill/percentage title when contextUsage is null despite contextWindowTokens being configured', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={1000}
          contextUsage={null}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      // No usage event received yet: 0% fill, no title (nothing to report).
      expect(bar.getAttribute('aria-valuenow')).toBe('0');
      expect(bar.getAttribute('title')).toBeNull();
      expect(bar.querySelector('div')?.style.width).toBe('0%');
    });
  });

  describe('contextWindowTokens undefined (indeterminate)', () => {
    it('renders role="progressbar" with no aria-valuenow/min/max attributes', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={undefined}
          contextUsage={{ promptTokens: 300, estimated: true }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBeNull();
      expect(bar.getAttribute('aria-valuemin')).toBeNull();
      expect(bar.getAttribute('aria-valuemax')).toBeNull();
    });

    it('renders the dashed/indeterminate track instead of a solid fill', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={undefined}
          contextUsage={{ promptTokens: 300, estimated: true }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      // No nested solid-fill child div (unlike the determinate case).
      expect(bar.querySelector('div')).toBeNull();
      expect(bar.style.backgroundImage).toContain('repeating-linear-gradient');
    });

    it('shows a leading ~ and a trailing "(estimated)" clause when the reading is the chars/4 fallback (estimated: true)', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={undefined}
          contextUsage={{ promptTokens: 300, estimated: true }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('title')).toBe(
        '~300 tokens used (estimated); set contextWindowTokens for a gauge',
      );
    });

    it('omits the estimate indicator when the reading is provider-reported (estimated: false)', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={undefined}
          contextUsage={{ promptTokens: 300, estimated: false }}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('title')).toBe('300 tokens used; set contextWindowTokens for a gauge');
    });

    it('omits the title attribute when contextUsage is null', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={undefined}
          contextUsage={null}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('title')).toBeNull();
    });
  });

  describe('contextUsage null (no usage event received yet)', () => {
    it('renders without crashing when contextWindowTokens is also undefined', () => {
      render(
        <ContextUsageBar
          contextWindowTokens={undefined}
          contextUsage={null}
          softRatio={0.5}
          hardRatio={0.8}
        />,
      );

      expect(screen.getByRole('progressbar')).toBeTruthy();
    });

    it('renders without crashing when contextWindowTokens is defined', () => {
      const usage: EmbeddedAgentContextUsage | null = null;
      render(
        <ContextUsageBar
          contextWindowTokens={128000}
          contextUsage={usage}
          softRatio={0.75}
          hardRatio={0.9}
        />,
      );

      expect(screen.getByRole('progressbar')).toBeTruthy();
    });
  });
});
