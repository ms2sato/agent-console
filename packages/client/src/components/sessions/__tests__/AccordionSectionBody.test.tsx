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

  it('is inert when collapsed -- removes the wrapper (and every descendant) from the tab order and from Chrome\'s keyboard-focusable-scroller behavior', () => {
    const { container } = render(
      <AccordionSectionBody isExpanded={false}>
        <span>Section content</span>
      </AccordionSectionBody>
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.hasAttribute('inert')).toBe(true);
  });

  it('is not inert when expanded', () => {
    const { container } = render(
      <AccordionSectionBody isExpanded={true}>
        <span>Section content</span>
      </AccordionSectionBody>
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.hasAttribute('inert')).toBe(false);
  });

  it('sets inert to the empty string, never a boolean, when collapsed', () => {
    // React 18 / @types/react 18.3 do not know the `inert` attribute; passing
    // a boolean `true` gets silently dropped (with a console warning) since
    // React treats an unrecognized attribute as a plain DOM attribute, where
    // only a string (or `undefined` to omit it) is valid. The empty-string
    // attribute (`inert=""` present / attribute absent) is the only shape
    // `react-inert.d.ts` admits, and it is the contract this pins.
    const { container } = render(
      <AccordionSectionBody isExpanded={false}>
        <span>Section content</span>
      </AccordionSectionBody>
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('inert')).toBe('');
  });
});
