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
 * - runCommand: Execute shell commands (npm, build scripts, etc.) - synchronous
 * - startProcess: Start a long-running process (dev server, etc.) - background
 * - stopProcess: Stop a running background process
 * - listProcesses: List all running background processes
 * - getProcessLogs: Get logs from a running process
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
import { ProcessManagerService } from './process-manager.service';
import * as pty from 'node-pty';

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

  constructor(private readonly processManager: ProcessManagerService) {}

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
            // Use spawnSync to capture both stdout and stderr properly
            const result = spawnSync(input.command, [], {
              cwd: basePath,
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024 * 5, // 5MB buffer for large outputs
              timeout: 120000, // 2 minute timeout for sync commands
              shell: true, // Run through shell for command parsing
              stdio: ['pipe', 'pipe', 'pipe'], // Capture stdin, stdout, stderr
            });

            // Combine stdout and stderr for complete output
            const stdout = result.stdout?.trim() || '';
            const stderr = result.stderr?.trim() || '';
            
            // Build combined output - many tools write to stderr even on success (spinners, progress)
            let output = '';
            if (stdout) output += stdout;
            if (stderr) {
              if (output) output += '\n--- stderr ---\n';
              output += stderr;
            }
            if (!output) output = '(no output)';

            // Check exit code for failure
            if (result.status !== 0) {
              report(`Command failed with exit code ${result.status}`);
              return `Command failed (exit code ${result.status}):\n${output}`;
            }

            report(`Command completed`);
            return output;
          } catch (err: unknown) {
            const errObj = err as { stdout?: string; stderr?: string; message?: string } | null;
            const stdout = errObj?.stdout?.toString?.() || '';
            const stderr = errObj?.stderr?.toString?.() || '';
            const combined = [stdout, stderr].filter(Boolean).join('\n') || toErrorMessage(err);
            return `Command failed: ${combined}`;
          }
        },
        {
          name: 'runCommand',
          description: `Run a shell command synchronously (waits for completion). Use for short commands like:
- npm install, npm run build, npm test
- git commands, file operations
- Any command that completes quickly

For long-running processes (servers, dev mode, watch mode), use startProcess instead.`,
          schema: z.object({
            command: z.string().describe('Shell command to run in project root'),
          }),
        },
      ),

      startProcess: tool(
        async (input: { command: string; waitForReady?: string; port?: number; waitTimeoutMs?: number }) => {
          report(`Starting background process: ${input.command}`);

          const result = await this.processManager.startProcess({
            command: input.command,
            cwd: basePath,
            waitForReady: input.waitForReady,
            waitTimeoutMs: input.waitTimeoutMs ?? 30000,
            port: input.port,
            onLog: (line) => {
              // Stream important logs to progress
              if (line.includes('error') || line.includes('Error') ||
                  line.includes('listening') || line.includes('ready') ||
                  line.includes('started') || line.includes('compiled')) {
                report(line);
              }
            },
            maxLogLines: 200,
          });

          if (result.success) {
            const portInfo = result.port ? ` on port ${result.port}` : '';
            const urlInfo = result.url ? ` (${result.url})` : '';
            report(`Process started${portInfo}${urlInfo}`);

            return JSON.stringify({
              success: true,
              processId: result.processId,
              pid: result.pid,
              port: result.port,
              url: result.url,
              message: `Process running (ID: ${result.processId})${portInfo}${urlInfo}`,
              logs: result.logs.slice(-30), // Return last 30 log lines
              IMPORTANT: `CAREFULLY review the logs above! If you see "Error", "error", "failed", "warning", stack traces, or any problems - YOU MUST report them to the user! Do not say "running successfully" if there are errors in the logs.`,
            }, null, 2);
          } else {
            report(`Failed to start process: ${result.error}`);
            return JSON.stringify({
              success: false,
              error: result.error,
              logs: result.logs,
            }, null, 2);
          }
        },
        {
          name: 'startProcess',
          description: `Start a long-running background process (dev server, watch mode, etc.).
Returns immediately with process ID and captured logs. The process keeps running in background.

Use this for:
- npm run dev, npm start, npm run watch
- Any server or process that doesn't exit on its own
- Processes where you need to see the output while running

The waitForReady parameter waits for a specific text in output before returning (e.g., "listening on port", "ready", "compiled successfully").

Examples:
- startProcess({ command: "npm run dev", port: 3000, waitForReady: "ready" })
- startProcess({ command: "npm start", port: 8080, waitForReady: "listening" })`,
          schema: z.object({
            command: z.string().describe('Shell command to run (e.g., "npm run dev", "npm start")'),
            waitForReady: z.string().optional().describe('Text to wait for in output before returning (e.g., "listening", "ready", "compiled")'),
            port: z.number().optional().describe('Port the process will listen on (for reference)'),
            waitTimeoutMs: z.number().optional().describe('Max time to wait for ready signal in ms (default: 30000)'),
          }),
        },
      ),

      stopProcess: tool(
        async (input: { processId: string }) => {
          report(`Stopping process: ${input.processId}`);

          const result = await this.processManager.stopProcess(input.processId);

          if (result.success) {
            report(`Process ${input.processId} stopped`);
            return JSON.stringify({
              success: true,
              message: `Process ${input.processId} has been stopped`,
              finalLogs: result.logs.slice(-10), // Last 10 log lines before stop
            }, null, 2);
          } else {
            return JSON.stringify({
              success: false,
              error: result.error,
              logs: result.logs,
            }, null, 2);
          }
        },
        {
          name: 'stopProcess',
          description: 'Stop a running background process by its ID. Get the process ID from startProcess or listProcesses.',
          schema: z.object({
            processId: z.string().describe('The process ID returned by startProcess'),
          }),
        },
      ),

      listProcesses: tool(
        async () => {
          const processes = this.processManager.listProcesses();

          if (processes.length === 0) {
            return JSON.stringify({
              success: true,
              message: 'No running processes',
              processes: [],
            }, null, 2);
          }

          const summary = processes.map((p) => ({
            id: p.id,
            command: p.command,
            status: p.status,
            pid: p.pid,
            port: p.port,
            url: p.url,
            startedAt: p.startedAt.toISOString(),
            recentLogs: p.logs.slice(-5), // Last 5 log lines
          }));

          return JSON.stringify({
            success: true,
            message: `${processes.length} running process(es)`,
            processes: summary,
          }, null, 2);
        },
        {
          name: 'listProcesses',
          description: 'List all running background processes with their IDs, status, and recent logs.',
          schema: z.object({}),
        },
      ),

      getProcessLogs: tool(
        async (input: { processId: string; tailLines?: number }) => {
          const processInfo = this.processManager.getProcess(input.processId);

          if (!processInfo) {
            return JSON.stringify({
              success: false,
              error: `Process ${input.processId} not found`,
            }, null, 2);
          }

          const logs = this.processManager.getProcessLogs(input.processId, input.tailLines ?? 50);

          return JSON.stringify({
            success: true,
            processId: input.processId,
            status: processInfo.status,
            command: processInfo.command,
            port: processInfo.port,
            url: processInfo.url,
            logCount: logs.length,
            logs: logs,
          }, null, 2);
        },
        {
          name: 'getProcessLogs',
          description: 'Get logs from a running or recently stopped process. Useful for debugging or checking what went wrong.',
          schema: z.object({
            processId: z.string().describe('The process ID'),
            tailLines: z.number().optional().describe('Number of recent log lines to return (default: 50)'),
          }),
        },
      ),

      interactiveCommand: tool(
        async (input: { command: string; inputs?: Array<{ wait?: string; send: string }> }) => {
          report(`Running interactive: ${input.command}`);

          return new Promise((resolve) => {
            const output: string[] = [];
            let currentInputIndex = 0;
            const inputs = input.inputs ?? [];
            let inputTimeout: NodeJS.Timeout | null = null;
            let completionTimeout: NodeJS.Timeout | null = null;

            // Special key mappings
            const specialKeys: Record<string, string> = {
              ENTER: '\r',
              UP: '\x1b[A',
              DOWN: '\x1b[B',
              LEFT: '\x1b[C',
              RIGHT: '\x1b[D',
              SPACE: ' ',
              TAB: '\t',
              ESCAPE: '\x1b',
              CTRL_C: '\x03',
            };

            const parseInput = (sendValue: string): string => {
              // Replace special key placeholders like {ENTER}, {UP}, {DOWN}
              return sendValue.replace(/\{(\w+)\}/g, (match, key) => {
                return specialKeys[key.toUpperCase()] ?? match;
              });
            };

            try {
              const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
              const shellArgs = process.platform === 'win32' ? [] : ['-c', input.command];
              const ptyCommand = process.platform === 'win32' ? input.command : shell;

              const ptyProcess = pty.spawn(ptyCommand, shellArgs, {
                name: 'xterm-256color',
                cols: 120,
                rows: 30,
                cwd: basePath,
                env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
              });

              const cleanup = () => {
                if (inputTimeout) clearTimeout(inputTimeout);
                if (completionTimeout) clearTimeout(completionTimeout);
                try {
                  ptyProcess.kill();
                } catch {
                  // Process may already be dead
                }
              };

              const tryNextInput = () => {
                if (currentInputIndex >= inputs.length) return;

                const currentInput = inputs[currentInputIndex];
                const fullOutput = output.join('');

                // Check if we should send this input
                if (!currentInput.wait || fullOutput.includes(currentInput.wait)) {
                  const dataToSend = parseInput(currentInput.send);
                  ptyProcess.write(dataToSend);
                  report(`Sent input: ${currentInput.send}`);
                  currentInputIndex++;

                  // Schedule next input check
                  if (currentInputIndex < inputs.length) {
                    inputTimeout = setTimeout(tryNextInput, 500);
                  }
                }
              };

              ptyProcess.onData((data: string) => {
                // Strip ANSI escape codes for cleaner output
                const cleanData = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
                output.push(cleanData);

                // Reset completion timeout on new data
                if (completionTimeout) clearTimeout(completionTimeout);
                completionTimeout = setTimeout(() => {
                  // If no more inputs and output has settled, we're done
                  if (currentInputIndex >= inputs.length) {
                    cleanup();
                    const finalOutput = output.join('').trim();
                    resolve(JSON.stringify({
                      success: true,
                      output: finalOutput.slice(-5000), // Last 5000 chars
                      inputsSent: currentInputIndex,
                    }, null, 2));
                  }
                }, 3000); // Wait 3s of silence before considering done

                // Try to send next input based on output
                tryNextInput();
              });

              ptyProcess.onExit(({ exitCode }) => {
                cleanup();
                const finalOutput = output.join('').trim();
                report(`Interactive command exited with code ${exitCode}`);
                resolve(JSON.stringify({
                  success: exitCode === 0,
                  exitCode,
                  output: finalOutput.slice(-5000),
                  inputsSent: currentInputIndex,
                }, null, 2));
              });

              // Overall timeout (2 minutes)
              setTimeout(() => {
                cleanup();
                const finalOutput = output.join('').trim();
                resolve(JSON.stringify({
                  success: false,
                  error: 'Command timed out after 2 minutes',
                  output: finalOutput.slice(-5000),
                  inputsSent: currentInputIndex,
                }, null, 2));
              }, 120000);

              // Start checking for inputs after a short delay
              setTimeout(tryNextInput, 500);

            } catch (err: unknown) {
              resolve(JSON.stringify({
                success: false,
                error: `Failed to start interactive command: ${toErrorMessage(err)}`,
              }, null, 2));
            }
          });
        },
        {
          name: 'interactiveCommand',
          description: `Run an interactive terminal command that requires user input (prompts, selections, etc.).

Use this ONLY when:
- A command shows interactive prompts (like npm init, create-react-app with prompts)
- You need to navigate menus with arrow keys
- The command requires selecting options or entering text interactively

The inputs array defines a sequence of responses:
- wait: Optional text to wait for before sending (e.g., "package manager", "project name")
- send: The input to send. Use special keys: {ENTER}, {UP}, {DOWN}, {LEFT}, {RIGHT}, {SPACE}, {TAB}

Examples:
1. Select 2nd option (npm) from a list:
   interactiveCommand({
     command: "npx create-vite my-app",
     inputs: [
       { wait: "package manager", send: "{DOWN}{ENTER}" }
     ]
   })

2. Answer multiple prompts:
   interactiveCommand({
     command: "npm init",
     inputs: [
       { wait: "package name", send: "my-app{ENTER}" },
       { wait: "version", send: "{ENTER}" },
       { wait: "description", send: "My awesome app{ENTER}" }
     ]
   })

PREFER non-interactive alternatives when available:
- npx create-vite my-app --template react (instead of interactive)
- npm init -y (instead of interactive prompts)`,
          schema: z.object({
            command: z.string().describe('The command to run'),
            inputs: z.array(z.object({
              wait: z.string().optional().describe('Text to wait for before sending input'),
              send: z.string().describe('Input to send. Use {ENTER}, {UP}, {DOWN}, {SPACE} for special keys'),
            })).optional().describe('Sequence of inputs to send'),
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
