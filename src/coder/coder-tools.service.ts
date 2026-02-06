/**
 * Tools for the CODER SUB-AGENT. All operations are scoped to data/coder/{project_folder}.
 *
 * File Tools:
 * - listDir: List directory contents
 * - readFile: Read entire file
 * - readFileLines: Read specific line range from a file
 * - writeFile: Write/create files
 * - grepCode: Search for patterns across files
 *
 * Command Tools:
 * - runCommand: Execute shell commands (npm, build scripts, etc.)
 *
 * Git Tools:
 * - gitClone: Clone a repository
 * - gitStatus: Show working tree status
 * - gitDiff: Show changes (staged/unstaged)
 * - gitAdd: Stage files
 * - gitCommit: Commit changes
 * - gitPush: Push to remote
 * - gitBranch: List/create/switch/delete branches
 *
 * Supports an optional onProgress callback for step-by-step reporting.
 */
import { Injectable, Logger } from '@nestjs/common';
import { tool } from '@langchain/core/tools';
import * as z from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawnSync } from 'child_process';

const CODER_ROOT = 'data/coder';

function toErrorMessage(e: unknown): string {
  if (e == null) return 'Unknown error';
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

@Injectable()
export class CoderToolsService {
  private readonly logger = new Logger(CoderToolsService.name);

  /**
   * Resolve and validate that the target path is under the coder project root.
   * Throws if the path escapes the project directory.
   */
  private resolvePath(projectFolder: string, relativePath: string): string {
    const base = path.join(process.cwd(), CODER_ROOT, projectFolder);
    const resolved = path.resolve(base, relativePath || '.');
    const baseReal = path.resolve(base);
    if (!resolved.startsWith(baseReal)) {
      throw new Error(`Path escapes project directory: ${relativePath}`);
    }
    return resolved;
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Get tools for the coder agent. projectFolder is used as the subdir under data/coder/.
   * onProgress is called for significant actions so the runner can send Telegram updates.
   */
  getTools(
    projectFolder: string,
    onProgress?: (message: string) => void,
  ): Record<string, ReturnType<typeof tool>> {
    const basePath = path.join(process.cwd(), CODER_ROOT, projectFolder);
    this.ensureDir(path.join(process.cwd(), CODER_ROOT));
    this.ensureDir(basePath);

    const report = (msg: string) => {
      this.logger.log(msg);
      onProgress?.(msg);
    };

    const safePath = (p: string) => this.resolvePath(projectFolder, p);

    return {
      listDir: tool(
        async (input: { path?: string }) => {
          const target = safePath(input.path ?? '.');
          if (!fs.existsSync(target)) {
            return `Directory does not exist: ${input.path ?? '.'}`;
          }
          const stat = fs.statSync(target);
          if (!stat.isDirectory()) {
            return `Not a directory: ${input.path ?? '.'}`;
          }
          const entries = fs.readdirSync(target, { withFileTypes: true });
          const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          return lines.join('\n');
        },
        {
          name: 'listDir',
          description: 'List contents of a directory. Path is relative to the project root.',
          schema: z.object({
            path: z.string().optional().describe('Relative path (default: project root)'),
          }),
        },
      ),

      readFile: tool(
        async (input: { path: string }) => {
          const target = safePath(input.path);
          if (!fs.existsSync(target)) {
            return `File not found: ${input.path}`;
          }
          const stat = fs.statSync(target);
          if (!stat.isFile()) {
            return `Not a file: ${input.path}`;
          }
          return fs.readFileSync(target, 'utf-8');
        },
        {
          name: 'readFile',
          description: 'Read the contents of a file. Path is relative to the project root.',
          schema: z.object({
            path: z.string().describe('Relative path to the file'),
          }),
        },
      ),

      writeFile: tool(
        async (input: { path: string; content: string }) => {
          const target = safePath(input.path);
          this.ensureDir(path.dirname(target));
          fs.writeFileSync(target, input.content, 'utf-8');
          report(`Written file: ${input.path}`);
          return `Written ${input.path}`;
        },
        {
          name: 'writeFile',
          description: 'Write content to a file. Creates parent directories if needed. Path is relative to the project root.',
          schema: z.object({
            path: z.string().describe('Relative path to the file'),
            content: z.string().describe('File content'),
          }),
        },
      ),

      runCommand: tool(
        async (input: { command: string }) => {
          report(`Running: ${input.command}`);
          try {
            const result = execSync(input.command, {
              cwd: basePath,
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024,
            });
            return result?.trim() || '(no output)';
          } catch (err: unknown) {
            const msg =
              err != null && typeof err === 'object' && 'stderr' in err
                ? (err as { stderr?: { toString?: () => string } }).stderr?.toString?.()
                : null;
            return `Command failed: ${msg || toErrorMessage(err)}`;
          }
        },
        {
          name: 'runCommand',
          description: 'Run a shell command in the project root directory (e.g. npm install, npm run build). Use for running scripts, installs, tests.',
          schema: z.object({
            command: z.string().describe('Shell command to run in project root'),
          }),
        },
      ),

      gitClone: tool(
        async (input: { url: string; folder?: string }) => {
          const folderName = input.folder ?? path.basename(input.url.replace(/\.git$/, ''));
          const coderBase = path.join(process.cwd(), CODER_ROOT);
          const targetDir = path.join(coderBase, folderName);
          if (!targetDir.startsWith(path.resolve(coderBase))) {
            return 'Invalid folder name.';
          }
          if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
            return `Directory already exists and is not empty: ${folderName}. Use a different folder or remove it first.`;
          }
          this.ensureDir(coderBase);
          report(`Cloning ${input.url}...`);
          try {
            const r = spawnSync('git', ['clone', input.url, targetDir], {
              encoding: 'utf-8',
              stdio: 'pipe',
            });
            if (r.status !== 0) {
              const stderr = r.stderr?.toString() || (r.error ? toErrorMessage(r.error) : 'Unknown error');
              return `Clone failed: ${stderr}`;
            }
            report(`Cloned into ${folderName}`);
            return `Cloned into ${folderName}`;
          } catch (err: unknown) {
            const msg =
              err != null && typeof err === 'object' && 'stderr' in err
                ? (err as { stderr?: { toString?: () => string } }).stderr?.toString?.()
                : null;
            return `Clone failed: ${msg || toErrorMessage(err)}`;
          }
        },
        {
          name: 'gitClone',
          description: 'Clone a git repository into data/coder/{folder}. If folder is omitted, use repo name from URL.',
          schema: z.object({
            url: z.string().describe('Git clone URL'),
            folder: z.string().optional().describe('Project folder name under data/coder (default: repo name)'),
          }),
        },
      ),

      gitStatus: tool(
        async () => {
          try {
            const result = execSync('git status --short', { cwd: basePath, encoding: 'utf-8' });
            return result?.trim() || 'Clean working tree';
          } catch (err: unknown) {
            return `git status failed: ${toErrorMessage(err)}`;
          }
        },
        {
          name: 'gitStatus',
          description: 'Run git status in the project directory.',
          schema: z.object({}),
        },
      ),

      gitAdd: tool(
        async (input: { paths?: string }) => {
          const paths = input.paths ?? '.';
          report(`git add ${paths}`);
          try {
            const r = spawnSync('git', ['add', paths], { cwd: basePath, encoding: 'utf-8' });
            if (r.status !== 0) {
              return `git add failed: ${r.stderr?.toString() || (r.error ? toErrorMessage(r.error) : 'Unknown')}`;
            }
            return 'Staged.';
          } catch (err: unknown) {
            return `git add failed: ${toErrorMessage(err)}`;
          }
        },
        {
          name: 'gitAdd',
          description: 'Stage files (git add). Use "." to stage all.',
          schema: z.object({
            paths: z.string().optional().describe('Paths to stage (default: .)'),
          }),
        },
      ),

      gitCommit: tool(
        async (input: { message: string }) => {
          report(`Committing: ${input.message}`);
          try {
            const r = spawnSync('git', ['commit', '-m', input.message], {
              cwd: basePath,
              encoding: 'utf-8',
            });
            if (r.status !== 0) {
              return `git commit failed: ${r.stderr?.toString() || (r.error ? toErrorMessage(r.error) : 'Unknown')}`;
            }
            return 'Committed.';
          } catch (err: unknown) {
            return `git commit failed: ${toErrorMessage(err)}`;
          }
        },
        {
          name: 'gitCommit',
          description: 'Commit staged changes with the given message.',
          schema: z.object({
            message: z.string().describe('Commit message'),
          }),
        },
      ),

      gitPush: tool(
        async () => {
          report('Pushing...');
          try {
            const result = execSync('git push', { cwd: basePath, encoding: 'utf-8' });
            report('Pushed.');
            return result?.trim() || 'Pushed.';
          } catch (err: unknown) {
            const msg =
              err != null && typeof err === 'object' && 'stderr' in err
                ? (err as { stderr?: { toString?: () => string } }).stderr?.toString?.()
                : null;
            return `git push failed: ${msg || toErrorMessage(err)}`;
          }
        },
        {
          name: 'gitPush',
          description: 'Push commits to the remote.',
          schema: z.object({}),
        },
      ),

      grepCode: tool(
        async (input: { pattern: string; path?: string; filePattern?: string }) => {
          const searchPath = safePath(input.path ?? '.');
          if (!fs.existsSync(searchPath)) {
            return `Path not found: ${input.path ?? '.'}`;
          }

          report(`Searching for "${input.pattern}"...`);

          try {
            // Build grep command with options
            const grepArgs = [
              '-r', // recursive
              '-n', // line numbers
              '-I', // skip binary files
              '--include', input.filePattern || '*', // file pattern filter
              input.pattern,
              searchPath,
            ];

            const result = spawnSync('grep', grepArgs, {
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024,
            });

            if (result.status === 1) {
              return 'No matches found.';
            }

            if (result.status !== 0 && result.status !== 1) {
              return `grep failed: ${result.stderr?.toString() || 'Unknown error'}`;
            }

            const output = result.stdout?.trim() || 'No matches found.';
            // Limit output to prevent overwhelming responses
            const lines = output.split('\n');
            if (lines.length > 100) {
              return `Found ${lines.length} matches (showing first 100):\n\n${lines.slice(0, 100).join('\n')}\n\n... and ${lines.length - 100} more matches`;
            }
            return `Found ${lines.length} matches:\n\n${output}`;
          } catch (err: unknown) {
            return `grep failed: ${toErrorMessage(err)}`;
          }
        },
        {
          name: 'grepCode',
          description: 'Search for a pattern across files in the project. Returns matching lines with file paths and line numbers. Useful for finding function definitions, imports, usages, etc.',
          schema: z.object({
            pattern: z.string().describe('The search pattern (regex supported)'),
            path: z.string().optional().describe('Directory to search in (default: project root)'),
            filePattern: z.string().optional().describe('File pattern filter, e.g., "*.ts" or "*.js" (default: all files)'),
          }),
        },
      ),

      readFileLines: tool(
        async (input: { path: string; startLine: number; endLine?: number }) => {
          const target = safePath(input.path);
          if (!fs.existsSync(target)) {
            return `File not found: ${input.path}`;
          }
          const stat = fs.statSync(target);
          if (!stat.isFile()) {
            return `Not a file: ${input.path}`;
          }

          const content = fs.readFileSync(target, 'utf-8');
          const lines = content.split('\n');
          const totalLines = lines.length;

          // Normalize line numbers (1-indexed)
          const start = Math.max(1, input.startLine) - 1;
          const end = input.endLine ? Math.min(input.endLine, totalLines) : Math.min(start + 50, totalLines);

          if (start >= totalLines) {
            return `Start line ${input.startLine} is beyond file end (${totalLines} lines)`;
          }

          const selectedLines = lines.slice(start, end);
          const numberedLines = selectedLines.map((line, i) => `${start + i + 1}: ${line}`);

          return `Lines ${start + 1}-${end} of ${totalLines}:\n\n${numberedLines.join('\n')}`;
        },
        {
          name: 'readFileLines',
          description: 'Read specific lines from a file. Useful for examining specific sections without loading entire large files. Line numbers are 1-indexed.',
          schema: z.object({
            path: z.string().describe('Relative path to the file'),
            startLine: z.number().describe('Starting line number (1-indexed)'),
            endLine: z.number().optional().describe('Ending line number (inclusive, default: startLine + 50)'),
          }),
        },
      ),

      gitDiff: tool(
        async (input: { staged?: boolean; file?: string }) => {
          try {
            const args = ['diff'];
            if (input.staged) {
              args.push('--staged');
            }
            if (input.file) {
              args.push('--', safePath(input.file));
            }

            const result = spawnSync('git', args, {
              cwd: basePath,
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024,
            });

            if (result.status !== 0) {
              return `git diff failed: ${result.stderr?.toString() || 'Unknown error'}`;
            }

            const output = result.stdout?.trim();
            if (!output) {
              return input.staged ? 'No staged changes.' : 'No unstaged changes.';
            }

            // Limit output for very large diffs
            const lines = output.split('\n');
            if (lines.length > 200) {
              return `Diff (${lines.length} lines, showing first 200):\n\n${lines.slice(0, 200).join('\n')}\n\n... truncated`;
            }
            return output;
          } catch (err: unknown) {
            return `git diff failed: ${toErrorMessage(err)}`;
          }
        },
        {
          name: 'gitDiff',
          description: 'Show git diff for unstaged or staged changes. Useful for reviewing changes before committing.',
          schema: z.object({
            staged: z.boolean().optional().describe('Show staged changes instead of unstaged (default: false)'),
            file: z.string().optional().describe('Specific file to diff (default: all files)'),
          }),
        },
      ),

      gitBranch: tool(
        async (input: { action?: string; name?: string }) => {
          const action = input.action ?? 'list';

          try {
            switch (action) {
              case 'list': {
                const result = execSync('git branch -a', { cwd: basePath, encoding: 'utf-8' });
                return result?.trim() || 'No branches found.';
              }

              case 'current': {
                const result = execSync('git branch --show-current', { cwd: basePath, encoding: 'utf-8' });
                return `Current branch: ${result?.trim() || 'detached HEAD'}`;
              }

              case 'create': {
                if (!input.name) {
                  return 'Branch name required for create action.';
                }
                report(`Creating branch: ${input.name}`);
                const r = spawnSync('git', ['checkout', '-b', input.name], {
                  cwd: basePath,
                  encoding: 'utf-8',
                });
                if (r.status !== 0) {
                  return `Failed to create branch: ${r.stderr?.toString() || 'Unknown error'}`;
                }
                return `Created and switched to branch: ${input.name}`;
              }

              case 'switch': {
                if (!input.name) {
                  return 'Branch name required for switch action.';
                }
                report(`Switching to branch: ${input.name}`);
                const r = spawnSync('git', ['checkout', input.name], {
                  cwd: basePath,
                  encoding: 'utf-8',
                });
                if (r.status !== 0) {
                  return `Failed to switch branch: ${r.stderr?.toString() || 'Unknown error'}`;
                }
                return `Switched to branch: ${input.name}`;
              }

              case 'delete': {
                if (!input.name) {
                  return 'Branch name required for delete action.';
                }
                report(`Deleting branch: ${input.name}`);
                const r = spawnSync('git', ['branch', '-d', input.name], {
                  cwd: basePath,
                  encoding: 'utf-8',
                });
                if (r.status !== 0) {
                  return `Failed to delete branch: ${r.stderr?.toString() || 'Unknown error'}`;
                }
                return `Deleted branch: ${input.name}`;
              }

              default:
                return `Unknown action: ${action}. Use: list, current, create, switch, or delete.`;
            }
          } catch (err: unknown) {
            return `git branch failed: ${toErrorMessage(err)}`;
          }
        },
        {
          name: 'gitBranch',
          description: 'Manage git branches: list all branches, show current branch, create new branch, switch branches, or delete branches.',
          schema: z.object({
            action: z.string().optional().describe('Action: "list" (default), "current", "create", "switch", or "delete"'),
            name: z.string().optional().describe('Branch name (required for create, switch, delete)'),
          }),
        },
      ),
    };
  }
}
