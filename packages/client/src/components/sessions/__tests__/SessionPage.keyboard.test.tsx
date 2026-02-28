/**
 * Tests for tab keyboard navigation.
 *
 * Core index-calculation logic is tested directly against the production
 * `getNextTabIndex` utility (pure function tests, no React needed).
 *
 * ARIA attribute behavior (tabIndex, aria-selected, roving focus) is tested
 * via a lightweight harness that imports `getNextTabIndex` from production
 * code, ensuring no logic duplication between tests and production.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { getNextTabIndex } from '../tabKeyboardNavigation';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Pure function tests for getNextTabIndex
// ---------------------------------------------------------------------------

describe('getNextTabIndex', () => {
  describe('ArrowRight', () => {
    it('moves to next tab', () => {
      expect(getNextTabIndex('ArrowRight', 0, 3)).toBe(1);
    });
    it('wraps from last to first', () => {
      expect(getNextTabIndex('ArrowRight', 2, 3)).toBe(0);
    });
  });

  describe('ArrowLeft', () => {
    it('moves to previous tab', () => {
      expect(getNextTabIndex('ArrowLeft', 2, 3)).toBe(1);
    });
    it('wraps from first to last', () => {
      expect(getNextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    });
  });

  describe('Home', () => {
    it('returns 0', () => {
      expect(getNextTabIndex('Home', 2, 3)).toBe(0);
    });
  });

  describe('End', () => {
    it('returns last index', () => {
      expect(getNextTabIndex('End', 0, 3)).toBe(2);
    });
  });

  describe('non-navigation keys', () => {
    it('returns null for unrelated keys', () => {
      expect(getNextTabIndex('Enter', 0, 3)).toBeNull();
      expect(getNextTabIndex('Tab', 0, 3)).toBeNull();
      expect(getNextTabIndex('Escape', 0, 3)).toBeNull();
    });
  });

  describe('negative currentIndex (activeTabId not in tabs)', () => {
    it('ArrowRight from -1 goes to index 0', () => {
      expect(getNextTabIndex('ArrowRight', -1, 3)).toBe(0);
    });
    it('ArrowLeft from -1 goes to index 1', () => {
      expect(getNextTabIndex('ArrowLeft', -1, 3)).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('returns null for empty tab list', () => {
      expect(getNextTabIndex('ArrowRight', 0, 0)).toBeNull();
    });
    it('handles single tab wrap', () => {
      expect(getNextTabIndex('ArrowRight', 0, 1)).toBe(0);
      expect(getNextTabIndex('ArrowLeft', 0, 1)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests for ARIA attributes and roving tabindex
// ---------------------------------------------------------------------------

interface Tab {
  id: string;
  name: string;
}

/**
 * Minimal harness that uses the production `getNextTabIndex` function
 * to drive keyboard navigation - no logic duplication.
 *
 * NOTE: The harness uses setActiveTabId directly for click/keyboard handlers.
 * This tests ARIA attribute behavior (tabIndex, aria-selected) but does NOT
 * cover the router navigation path (handleTabClick -> navigateToWorker) used
 * in production. That integration requires rendering the full SessionPage.
 */
function TabBarHarness({ tabs, initialActiveTabId }: { tabs: Tab[]; initialActiveTabId: string }) {
  const [activeTabId, setActiveTabId] = useState(initialActiveTabId);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const currentIndex = activeTabId ? tabs.findIndex(t => t.id === activeTabId) : 0;
    const newIndex = getNextTabIndex(e.key, currentIndex, tabs.length);
    if (newIndex === null) return;

    e.preventDefault();
    const newTabId = tabs[newIndex].id;
    setActiveTabId(newTabId);
    document.getElementById(`worker-tab-${newTabId}`)?.focus();
  };

  return (
    <>
      <div role="tablist" aria-label="Worker tabs" onKeyDown={handleKeyDown}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            role="tab"
            id={`worker-tab-${tab.id}`}
            aria-selected={tab.id === activeTabId}
            aria-controls={`worker-tabpanel-${tab.id}`}
            tabIndex={tab.id === activeTabId ? 0 : -1}
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.name}
          </button>
        ))}
      </div>
      {activeTabId && (
        <div
          role="tabpanel"
          id={`worker-tabpanel-${activeTabId}`}
          aria-labelledby={`worker-tab-${activeTabId}`}
        >
          {tabs.find(t => t.id === activeTabId)?.name} content
        </div>
      )}
    </>
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
  const allTabs = screen.getAllByRole('tab');
  const selected = allTabs.find(tab => tab.getAttribute('aria-selected') === 'true');
  return selected?.textContent ?? '';
}

describe('Tab keyboard navigation (integration)', () => {
  describe('ArrowRight', () => {
    it('should move to the next tab', async () => {
      const user = userEvent.setup();
      renderTabBar();

      getTab('Agent').focus();
      await user.keyboard('{ArrowRight}');

      expect(getSelectedTabName()).toBe('Shell 1');
      expect(document.activeElement).toBe(getTab('Shell 1'));
    });

    it('should wrap from last tab to first tab', async () => {
      const user = userEvent.setup();
      renderTabBar(threeTabs, 'terminal-2');

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

      getTab('Shell 1').focus();
      await user.keyboard('{ArrowLeft}');

      expect(getSelectedTabName()).toBe('Agent');
      expect(document.activeElement).toBe(getTab('Agent'));
    });

    it('should wrap from first tab to last tab', async () => {
      const user = userEvent.setup();
      renderTabBar();

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

  describe('tab-to-panel ARIA relationship', () => {
    it('tab aria-controls matches tabpanel id', () => {
      const tabs: Tab[] = [
        { id: 'tab1', name: 'Agent' },
        { id: 'tab2', name: 'Shell 1' },
      ];
      render(<TabBarHarness tabs={tabs} initialActiveTabId="tab1" />);

      const tab1 = screen.getByRole('tab', { name: /Agent/ });
      expect(tab1.getAttribute('aria-controls')).toBe('worker-tabpanel-tab1');

      const panel1 = document.getElementById('worker-tabpanel-tab1');
      expect(panel1).not.toBeNull();
      expect(panel1?.getAttribute('role')).toBe('tabpanel');
    });

    it('tabpanel aria-labelledby matches tab id', () => {
      const tabs: Tab[] = [
        { id: 'tab1', name: 'Agent' },
      ];
      render(<TabBarHarness tabs={tabs} initialActiveTabId="tab1" />);

      const panel = document.getElementById('worker-tabpanel-tab1');
      expect(panel?.getAttribute('aria-labelledby')).toBe('worker-tab-tab1');
    });
  });
});
