/**
 * Branch name suggestion service
 *
 * Uses Claude CLI in non-interactive mode (-p) to suggest branch names
 * based on user's initial prompt and existing branch examples.
 */
import { execSync } from 'child_process';

interface BranchNameSuggestionRequest {
  prompt: string;
  repositoryPath: string;
  existingBranches?: string[];
}

interface BranchNameSuggestionResponse {
  branch: string;
  error?: string;
}

/**
 * Get list of branches from a repository
 */
function getBranches(repositoryPath: string): string[] {
  try {
    const output = execSync('git branch -a --list', {
      cwd: repositoryPath,
      encoding: 'utf-8',
    });
    return output
      .split('\n')
      .map(line => line.replace(/^\*?\s+/, '').replace(/^remotes\/[^/]+\//, '').trim())
      .filter(Boolean)
      .filter((branch, index, self) => self.indexOf(branch) === index); // unique
  } catch {
    return [];
  }
}

/**
 * Build the prompt for Claude to suggest a branch name
 */
function buildSuggestionPrompt(userPrompt: string, exampleBranches: string): string {
  return `You are a branch name generator. Given the following task description, suggest a single git branch name.

Task description:
${userPrompt}

${exampleBranches}

Rules:
- Output ONLY the branch name, nothing else
- Use lowercase letters, numbers, and hyphens only
- Use a prefix like feat/, fix/, refactor/, chore/, docs/, test/ if the repository uses them
- Keep it concise but descriptive (max 50 characters total)
- No spaces, underscores, or special characters except hyphens and forward slash for prefix

Branch name:`;
}

/**
 * Suggest a branch name using Claude CLI
 */
export async function suggestBranchName(
  request: BranchNameSuggestionRequest
): Promise<BranchNameSuggestionResponse> {
  const { prompt, repositoryPath, existingBranches } = request;

  // Get existing branches if not provided
  const branches = existingBranches ?? getBranches(repositoryPath);
  const exampleBranches = branches.length > 0
    ? `Example branches in this repository: ${branches.slice(0, 10).join(', ')}`
    : '';

  const suggestionPrompt = buildSuggestionPrompt(prompt, exampleBranches);

  try {
    // Use claude -p for non-interactive mode
    const result = execSync(
      `claude -p "${suggestionPrompt.replace(/"/g, '\\"')}" --output-format text`,
      {
        cwd: repositoryPath,
        encoding: 'utf-8',
        timeout: 30000, // 30 second timeout
        env: {
          ...process.env,
          // Ensure we don't inherit any interactive settings
          TERM: 'dumb',
        },
      }
    );

    // Clean up the result - extract just the branch name
    const branchName = result
      .trim()
      .split('\n')
      .pop() // Get last line (in case there's any preamble)
      ?.trim()
      .replace(/^["']|["']$/g, '') // Remove quotes if present
      .replace(/\s+/g, '-') // Replace any spaces with hyphens
      .toLowerCase();

    if (!branchName) {
      return {
        branch: '',
        error: 'Failed to generate branch name: empty response',
      };
    }

    // Validate branch name
    if (!/^[a-z0-9][a-z0-9/-]*[a-z0-9]$|^[a-z0-9]$/.test(branchName)) {
      // Try to sanitize
      const sanitized = branchName
        .replace(/[^a-z0-9/-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

      if (sanitized) {
        return { branch: sanitized };
      }

      return {
        branch: '',
        error: `Invalid branch name generated: ${branchName}`,
      };
    }

    return { branch: branchName };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      branch: '',
      error: `Failed to suggest branch name: ${message}`,
    };
  }
}

export { getBranches };
