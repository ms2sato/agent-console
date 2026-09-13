import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { AccordionSectionBody } from '../AccordionSectionBody';

describe('AccordionSectionBody', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the expanded grid-row class and aria-hidden=false when isExpanded is true', () => {
    const { container } = render(
      <AccordionSectionBody isExpanded={true}>
        <span>Section content</span>
      </AccordionSectionBody>
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('grid-rows-[1fr]');
    expect(wrapper.className).not.toContain('grid-rows-[0fr]');
    expect(wrapper.getAttribute('aria-hidden')).toBe('false');
  });

  it('renders the collapsed grid-row class and aria-hidden=true when isExpanded is false', () => {
    const { container } = render(
      <AccordionSectionBody isExpanded={false}>
        <span>Section content</span>
      </AccordionSectionBody>
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('grid-rows-[0fr]');
    expect(wrapper.className).not.toContain('grid-rows-[1fr]');
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps children mounted in the DOM when collapsed -- never conditionally removed', () => {
    render(
      <AccordionSectionBody isExpanded={false}>
        <span>Section content</span>
      </AccordionSectionBody>
    );

    expect(screen.getByText('Section content')).toBeTruthy();
  });

  it('keeps children mounted in the DOM when expanded', () => {
    render(
      <AccordionSectionBody isExpanded={true}>
        <span>Section content</span>
      </AccordionSectionBody>
    );

    expect(screen.getByText('Section content')).toBeTruthy();
  });
});
