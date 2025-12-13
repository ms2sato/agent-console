import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffFileList } from '../DiffFileList';
import type { GitDiffFile } from '@agent-console/shared';

describe('DiffFileList', () => {
  afterEach(() => {
    cleanup();
  });
  const mockFiles: GitDiffFile[] = [
    {
      path: 'src/components/Button.tsx',
      status: 'modified',
      stageState: 'staged',
      additions: 10,
      deletions: 5,
      isBinary: false,
    },
    {
      path: 'src/utils/helpers.ts',
      status: 'added',
      stageState: 'unstaged',
      additions: 20,
      deletions: 0,
      isBinary: false,
    },
    {
      path: 'README.md',
      status: 'modified',
      stageState: 'committed',
      additions: 2,
      deletions: 1,
      isBinary: false,
    },
    {
      path: 'assets/logo.png',
      status: 'added',
      stageState: 'staged',
      additions: 0,
      deletions: 0,
      isBinary: true,
    },
    {
      path: 'src/old-file.ts',
      status: 'deleted',
      stageState: 'staged',
      additions: 0,
      deletions: 15,
      isBinary: false,
    },
  ];

  it('renders empty state when no files', () => {
    const onSelectFile = mock(() => {});
    render(<DiffFileList files={[]} selectedPath={null} onSelectFile={onSelectFile} />);
    expect(screen.getByText('No changed files')).toBeTruthy();
  });

  it('renders file list with correct status labels', () => {
    const onSelectFile = mock(() => {});
    render(<DiffFileList files={mockFiles} selectedPath={null} onSelectFile={onSelectFile} />);

    // Check status labels
    expect(screen.getByText('[M*]')).toBeTruthy(); // Modified + staged
    expect(screen.getByText('[A]')).toBeTruthy(); // Added + unstaged
    expect(screen.getByText('[M]')).toBeTruthy(); // Modified + committed
    expect(screen.getByText('[D*]')).toBeTruthy(); // Deleted + staged
  });

  it('displays file names', () => {
    const onSelectFile = mock(() => {});
    render(<DiffFileList files={mockFiles} selectedPath={null} onSelectFile={onSelectFile} />);

    expect(screen.getByText('Button.tsx')).toBeTruthy();
    expect(screen.getByText('helpers.ts')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
    expect(screen.getByText('logo.png')).toBeTruthy();
  });

  it('displays additions and deletions count', () => {
    const onSelectFile = mock(() => {});
    render(<DiffFileList files={mockFiles} selectedPath={null} onSelectFile={onSelectFile} />);

    expect(screen.getByText('+10')).toBeTruthy();
    expect(screen.getByText('-5')).toBeTruthy();
    expect(screen.getByText('+20')).toBeTruthy();
    expect(screen.getByText('-15')).toBeTruthy();
  });

  it('displays binary indicator for binary files', () => {
    const onSelectFile = mock(() => {});
    render(<DiffFileList files={mockFiles} selectedPath={null} onSelectFile={onSelectFile} />);

    expect(screen.getByText('binary')).toBeTruthy();
  });

  it('highlights selected file', () => {
    const onSelectFile = mock(() => {});
    const { container } = render(
      <DiffFileList
        files={mockFiles}
        selectedPath="src/components/Button.tsx"
        onSelectFile={onSelectFile}
      />
    );

    // Find the selected file element - it should have bg-slate-700 class
    const selectedElement = container.querySelector('.bg-slate-700');
    expect(selectedElement).toBeTruthy();
    expect(selectedElement?.textContent).toContain('Button.tsx');
  });

  it('calls onSelectFile when clicking a file', async () => {
    const user = userEvent.setup();
    const onSelectFile = mock(() => {});
    render(<DiffFileList files={mockFiles} selectedPath={null} onSelectFile={onSelectFile} />);

    const button = screen.getByText('Button.tsx');
    await user.click(button);

    expect(onSelectFile).toHaveBeenCalledWith('src/components/Button.tsx');
  });

  it('groups files by directory', () => {
    const onSelectFile = mock(() => {});
    render(<DiffFileList files={mockFiles} selectedPath={null} onSelectFile={onSelectFile} />);

    // Should show directory names
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('components')).toBeTruthy();
    expect(screen.getByText('utils')).toBeTruthy();
    expect(screen.getByText('assets')).toBeTruthy();
  });

  it('handles renamed files', () => {
    const renamedFile: GitDiffFile = {
      path: 'src/NewComponent.tsx',
      status: 'renamed',
      stageState: 'staged',
      oldPath: 'src/OldComponent.tsx',
      additions: 5,
      deletions: 2,
      isBinary: false,
    };

    const onSelectFile = mock(() => {});
    render(<DiffFileList files={[renamedFile]} selectedPath={null} onSelectFile={onSelectFile} />);

    expect(screen.getByText('[R]')).toBeTruthy();
    expect(screen.getByText('NewComponent.tsx')).toBeTruthy();
    expect(screen.getByText(/from OldComponent\.tsx/)).toBeTruthy();
  });

  it('handles untracked files', () => {
    const untrackedFile: GitDiffFile = {
      path: 'test.txt',
      status: 'untracked',
      stageState: 'unstaged',
      additions: 10,
      deletions: 0,
      isBinary: false,
    };

    const onSelectFile = mock(() => {});
    render(<DiffFileList files={[untrackedFile]} selectedPath={null} onSelectFile={onSelectFile} />);

    expect(screen.getByText('[?]')).toBeTruthy();
  });
});
