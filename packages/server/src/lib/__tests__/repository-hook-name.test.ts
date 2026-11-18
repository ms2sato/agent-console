import { describe, it, expect } from 'bun:test';
import { resolveRepoTemplateName } from '../repository-hook-name.js';

describe('resolveRepoTemplateName', () => {
  it('returns the checkout directory name', () => {
    expect(resolveRepoTemplateName('/srv/repos/my-repo')).toBe('my-repo');
  });

  it('ignores a trailing slash', () => {
    expect(resolveRepoTemplateName('/srv/repos/my-repo/')).toBe('my-repo');
  });

  it('returns a bare-repository directory name as-is (.git suffix included)', () => {
    expect(resolveRepoTemplateName('/srv/repos/my-repo.git')).toBe('my-repo.git');
  });
});
