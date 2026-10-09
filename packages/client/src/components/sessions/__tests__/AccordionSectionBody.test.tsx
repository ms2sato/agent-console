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

  // happy-dom cannot measure actual pixel height; the pins below are
  // DOM-structure-only. The 0px visual claim is verified separately via
  // Browser QA, not by this test.

  it('keeps the caller className off the clipping layer when collapsed, nesting it on a child instead', () => {
    const { container } = render(
      <AccordionSectionBody isExpanded={false} className="max-h-96 overflow-y-auto px-4 py-3">
        <span>Section content</span>
      </AccordionSectionBody>
    );

    const clippingLayer = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(clippingLayer.className).toContain('overflow-hidden');
    expect(clippingLayer.className).not.toContain('overflow-y-auto');
    expect(clippingLayer.className.split(' ').some((cls) => /^p[xy]?-/.test(cls))).toBe(false);
    expect(clippingLayer.className.split(' ').some((cls) => /^py-/.test(cls))).toBe(false);

    const nestedChild = clippingLayer.firstElementChild as HTMLElement;
    expect(nestedChild.className).toContain('max-h-96');
    expect(nestedChild.className).toContain('overflow-y-auto');
    expect(nestedChild.className).toContain('px-4');
    expect(nestedChild.className).toContain('py-3');

    expect(nestedChild.contains(screen.getByText('Section content'))).toBe(true);
  });

  it('keeps the caller className off the clipping layer when expanded, nesting it on a child instead -- the structural split is state-independent', () => {
    const { container } = render(
      <AccordionSectionBody isExpanded={true} className="max-h-96 overflow-y-auto px-4 py-3">
        <span>Section content</span>
      </AccordionSectionBody>
    );

    const clippingLayer = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(clippingLayer.className).toContain('overflow-hidden');
    expect(clippingLayer.className).not.toContain('overflow-y-auto');
    expect(clippingLayer.className.split(' ').some((cls) => /^p[xy]?-/.test(cls))).toBe(false);
    expect(clippingLayer.className.split(' ').some((cls) => /^py-/.test(cls))).toBe(false);

    const nestedChild = clippingLayer.firstElementChild as HTMLElement;
    expect(nestedChild.className).toContain('max-h-96');
    expect(nestedChild.className).toContain('overflow-y-auto');
    expect(nestedChild.className).toContain('px-4');
    expect(nestedChild.className).toContain('py-3');

    expect(nestedChild.contains(screen.getByText('Section content'))).toBe(true);
  });

  it('always nests a child div even when className is undefined, and renders children inside it', () => {
    const { container } = render(
      <AccordionSectionBody isExpanded={false}>
        <span>Section content</span>
      </AccordionSectionBody>
    );

    const clippingLayer = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(clippingLayer.className).toContain('overflow-hidden');
    expect(clippingLayer.className).toContain('min-w-0');

    const nestedChild = clippingLayer.firstElementChild as HTMLElement;
    expect(nestedChild).toBeTruthy();
    expect(nestedChild.contains(screen.getByText('Section content'))).toBe(true);
  });
});
