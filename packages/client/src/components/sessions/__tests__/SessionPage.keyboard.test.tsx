/**
 * Tests for tab keyboard navigation in SessionPage.
 *
 * SessionPage cannot be rendered in unit tests due to complex dependencies
 * (xterm.js, WebSocket, TanStack Router). Instead, we test the keyboard
 * navigation behavior using a lightweight test harness component that
 * replicates the tablist DOM structure and keyboard handler logic from
 * SessionPage.tsx.
 */
import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, useCallback } from 'react';

afterEach(() => {
  cleanup();
});

interface Tab {
  id: string;
  name: string;
}

/**
 * Reproduces the exact keyboard handler logic from SessionPage.tsx.
 * This mirrors handleTabKeyDown in SessionPage.
 */
function TabBarHarness({ tabs, initialActiveTabId }: { tabs: Tab[]; initialActiveTabId: string }) {
  const [activeTabId, setActiveTabId] = useState(initialActiveTabId);
  const onTabClick = mock((tabId: string) => {
    setActiveTabId(tabId);
  });

  const handleTabKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (tabs.length === 0) return;

    const currentIndex = activeTabId ? tabs.findIndex(t => t.id === activeTabId) : 0;

    let newIndex: number | null = null;

    switch (e.key) {
      case 'ArrowRight':
        newIndex = (currentIndex + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        newIndex = 0;
        break;
      case 'End':
        newIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    const newTabId = tabs[newIndex].id;
    onTabClick(newTabId);

    const tabElement = document.getElementById(`worker-tab-${newTabId}`);
    tabElement?.focus();
  }, [tabs, activeTabId, onTabClick]);

  return (
    <div role="tablist" aria-label="Worker tabs" onKeyDown={handleTabKeyDown}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          role="tab"
          id={`worker-tab-${tab.id}`}
          aria-selected={tab.id === activeTabId}
          tabIndex={tab.id === activeTabId ? 0 : -1}
          onClick={() => onTabClick(tab.id)}
        >
          {tab.name}
        </button>
      ))}
    </div>
  );
}

const threeTabs: Tab[] = [
  { id: 'agent-1', name: 'Agent' },
  { id: 'terminal-1', name: 'Shell 1' },
  { id: 'terminal-2', name: 'Shell 2' },
];

function renderTabBar(tabs: Tab[] = threeTabs, initialActiveTabId = 'agent-1') {
  return render(<TabBarHarness tabs={tabs} initialActiveTabId={initialActiveTabId} />);
}

function getTab(name: string) {
  return screen.getByRole('tab', { name });
}

function getSelectedTabName(): string {
  const tabs = screen.getAllByRole('tab');
  const selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
  return selected?.textContent ?? '';
}

describe('Tab keyboard navigation', () => {
  describe('ArrowRight', () => {
    it('should move to the next tab', async () => {
      const user = userEvent.setup();
      renderTabBar();

      // Focus on the first tab (Agent) and press ArrowRight
      getTab('Agent').focus();
      await user.keyboard('{ArrowRight}');

      expect(getSelectedTabName()).toBe('Shell 1');
      expect(document.activeElement).toBe(getTab('Shell 1'));
    });

    it('should wrap from last tab to first tab', async () => {
      const user = userEvent.setup();
      renderTabBar(threeTabs, 'terminal-2');

      // Focus on the last tab (Shell 2) and press ArrowRight
      getTab('Shell 2').focus();
      await user.keyboard('{ArrowRight}');

      expect(getSelectedTabName()).toBe('Agent');
      expect(document.activeElement).toBe(getTab('Agent'));
    });
  });

  describe('ArrowLeft', () => {
    it('should move to the previous tab', async () => {
      const user = userEvent.setup();
      renderTabBar(threeTabs, 'terminal-1');

      // Focus on Shell 1 and press ArrowLeft
      getTab('Shell 1').focus();
      await user.keyboard('{ArrowLeft}');

      expect(getSelectedTabName()).toBe('Agent');
      expect(document.activeElement).toBe(getTab('Agent'));
    });

    it('should wrap from first tab to last tab', async () => {
      const user = userEvent.setup();
      renderTabBar();

      // Focus on Agent (first) and press ArrowLeft
      getTab('Agent').focus();
      await user.keyboard('{ArrowLeft}');

      expect(getSelectedTabName()).toBe('Shell 2');
      expect(document.activeElement).toBe(getTab('Shell 2'));
    });
  });

  describe('Home', () => {
    it('should move to the first tab', async () => {
      const user = userEvent.setup();
      renderTabBar(threeTabs, 'terminal-2');

      // Focus on Shell 2 (last) and press Home
      getTab('Shell 2').focus();
      await user.keyboard('{Home}');

      expect(getSelectedTabName()).toBe('Agent');
      expect(document.activeElement).toBe(getTab('Agent'));
    });

    it('should stay on the first tab if already there', async () => {
      const user = userEvent.setup();
      renderTabBar();

      getTab('Agent').focus();
      await user.keyboard('{Home}');

      expect(getSelectedTabName()).toBe('Agent');
      expect(document.activeElement).toBe(getTab('Agent'));
    });
  });

  describe('End', () => {
    it('should move to the last tab', async () => {
      const user = userEvent.setup();
      renderTabBar();

      // Focus on Agent (first) and press End
      getTab('Agent').focus();
      await user.keyboard('{End}');

      expect(getSelectedTabName()).toBe('Shell 2');
      expect(document.activeElement).toBe(getTab('Shell 2'));
    });

    it('should stay on the last tab if already there', async () => {
      const user = userEvent.setup();
      renderTabBar(threeTabs, 'terminal-2');

      getTab('Shell 2').focus();
      await user.keyboard('{End}');

      expect(getSelectedTabName()).toBe('Shell 2');
      expect(document.activeElement).toBe(getTab('Shell 2'));
    });
  });

  describe('consecutive navigation', () => {
    it('should handle multiple arrow key presses in sequence', async () => {
      const user = userEvent.setup();
      renderTabBar();

      getTab('Agent').focus();

      // ArrowRight twice: Agent -> Shell 1 -> Shell 2
      await user.keyboard('{ArrowRight}');
      expect(getSelectedTabName()).toBe('Shell 1');

      await user.keyboard('{ArrowRight}');
      expect(getSelectedTabName()).toBe('Shell 2');

      // ArrowLeft once: Shell 2 -> Shell 1
      await user.keyboard('{ArrowLeft}');
      expect(getSelectedTabName()).toBe('Shell 1');
    });
  });

  describe('non-navigation keys', () => {
    it('should not change tab on unrelated keys', async () => {
      const user = userEvent.setup();
      renderTabBar();

      getTab('Agent').focus();
      await user.keyboard('a');

      expect(getSelectedTabName()).toBe('Agent');
    });
  });

  describe('single tab', () => {
    it('should handle navigation with only one tab', async () => {
      const user = userEvent.setup();
      const singleTab: Tab[] = [{ id: 'agent-1', name: 'Agent' }];
      renderTabBar(singleTab);

      getTab('Agent').focus();
      await user.keyboard('{ArrowRight}');

      // Wraps to itself
      expect(getSelectedTabName()).toBe('Agent');
      expect(document.activeElement).toBe(getTab('Agent'));
    });
  });

  describe('ARIA attributes', () => {
    it('should have correct tabIndex values (0 for active, -1 for inactive)', () => {
      renderTabBar();

      const agentTab = getTab('Agent');
      const shell1Tab = getTab('Shell 1');
      const shell2Tab = getTab('Shell 2');

      expect(agentTab.getAttribute('tabindex')).toBe('0');
      expect(shell1Tab.getAttribute('tabindex')).toBe('-1');
      expect(shell2Tab.getAttribute('tabindex')).toBe('-1');
    });

    it('should update aria-selected when tab changes', async () => {
      const user = userEvent.setup();
      renderTabBar();

      getTab('Agent').focus();
      await user.keyboard('{ArrowRight}');

      expect(getTab('Agent').getAttribute('aria-selected')).toBe('false');
      expect(getTab('Shell 1').getAttribute('aria-selected')).toBe('true');
      expect(getTab('Shell 2').getAttribute('aria-selected')).toBe('false');
    });

    it('should update tabIndex roving focus when tab changes', async () => {
      const user = userEvent.setup();
      renderTabBar();

      getTab('Agent').focus();
      await user.keyboard('{ArrowRight}');

      expect(getTab('Agent').getAttribute('tabindex')).toBe('-1');
      expect(getTab('Shell 1').getAttribute('tabindex')).toBe('0');
      expect(getTab('Shell 2').getAttribute('tabindex')).toBe('-1');
    });
  });
});
