import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { WindowObservationsNotice, describeWindowObservations } from '../WindowObservationsNotice';

afterEach(() => {
  cleanup();
});

describe('describeWindowObservations', () => {
  it('returns no sentences when there is no observation (undefined or empty)', () => {
    expect(describeWindowObservations(undefined)).toEqual([]);
    expect(describeWindowObservations({})).toEqual([]);
  });

  it('describes a provider-stated limit with the number and the UTC date', () => {
    expect(
      describeWindowObservations({ providerStated: { tokens: 131072, observedAt: '2026-10-14T01:02:03.000Z' } }),
    ).toEqual(["A worker on this definition observed the provider's limit as 131,072 on 2026-10-14."]);
  });

  it('describes an apparent clamp without any number', () => {
    expect(describeWindowObservations({ apparentClamp: { observedAt: '2026-10-13T23:59:59.000Z' } })).toEqual([
      'Readings appear clamped since 2026-10-13.',
    ]);
  });

  it('keeps the two kinds as two separate sentences, never one merged window', () => {
    const sentences = describeWindowObservations({
      providerStated: { tokens: 1000, observedAt: '2026-01-01T00:00:00.000Z' },
      apparentClamp: { observedAt: '2026-01-02T00:00:00.000Z' },
    });
    expect(sentences).toHaveLength(2);
  });
});

describe('WindowObservationsNotice', () => {
  it('renders nothing in the default state (no observation)', () => {
    render(<WindowObservationsNotice observations={undefined} readOnlyNote="creator only" />);

    expect(screen.queryByTestId('window-observations-notice')).toBeNull();
    expect(screen.queryByText('creator only')).toBeNull();
  });

  it('renders the facts and the read-only note, and no button', () => {
    render(
      <WindowObservationsNotice
        observations={{ apparentClamp: { observedAt: '2026-10-13T00:00:00.000Z' } }}
        readOnlyNote="Only the creator can change this."
      />,
    );

    expect(screen.getByText('Readings appear clamped since 2026-10-13.')).toBeTruthy();
    expect(screen.getByText('Only the creator can change this.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
