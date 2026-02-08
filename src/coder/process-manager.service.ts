/**
 * PROCESS MANAGER SERVICE – Manages background processes for the coder agent.
 * Handles spawning, tracking, logging, and terminating long-running processes
 * like dev servers (npm run dev, npm start, etc.).
 *
 * Features:
 * - Spawn background processes with log capture
 * - Wait for "ready" signals (e.g., "listening on port")
 * - Stream logs in real-time via callbacks
 * - Stop processes by ID
 * - Auto-cleanup on module destroy
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface ProcessInfo {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  port?: number;
  url?: string;
  startedAt: Date;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  logs: string[];
  maxLogLines: number;
}

export interface StartProcessOptions {
  command: string;
  cwd: string;
  waitForReady?: string | RegExp;
  waitTimeoutMs?: number;
  port?: number;
  onLog?: (line: string) => void;
  maxLogLines?: number;
}

export interface StartProcessResult {
  success: boolean;
  processId?: string;
  pid?: number;
  port?: number;
  url?: string;
  logs: string[];
  error?: string;
}

@Injectable()
export class ProcessManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(ProcessManagerService.name);
  private readonly processes = new Map<string, { info: ProcessInfo; process: ChildProcess }>();
  private readonly events = new EventEmitter();

  async onModuleDestroy() {
    // Stop all running processes on shutdown
    this.logger.log(`Stopping ${this.processes.size} running processes...`);
    for (const [id] of this.processes) {
      await this.stopProcess(id);
    }
  }

  /**
   * Generate a short unique process ID
   */
  private generateId(): string {
    return `proc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * Start a background process
   */
  async startProcess(options: StartProcessOptions): Promise<StartProcessResult> {
    const {
      command,
      cwd,
      waitForReady,
      waitTimeoutMs = 30000,
      port,
      onLog,
      maxLogLines = 100,
    } = options;

    const id = this.generateId();
    const logs: string[] = [];

    this.logger.log(`Starting process ${id}: ${command} (cwd: ${cwd})`);

    return new Promise((resolve) => {
      try {
        // Spawn the process
        const proc = spawn('sh', ['-c', command], {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' }, // Disable color codes for cleaner logs
        });

        if (!proc.pid) {
          resolve({
            success: false,
            error: 'Failed to start process - no PID assigned',
            logs,
          });
          return;
        }

        const info: ProcessInfo = {
          id,
          command,
          cwd,
          pid: proc.pid,
          port,
          url: port ? `http://localhost:${port}` : undefined,
          startedAt: new Date(),
          status: 'starting',
          logs,
          maxLogLines,
        };

        this.processes.set(id, { info, process: proc });

        let readyResolved = false;
        let readyTimeout: NodeJS.Timeout | null = null;

        const addLog = (line: string) => {
          // Add to logs buffer (circular)
          logs.push(line);
          if (logs.length > maxLogLines) {
            logs.shift();
          }
          // Emit to callback
          onLog?.(line);
          // Emit event for external listeners
          this.events.emit(`log:${id}`, line);
        };

        const checkReady = (line: string) => {
          if (readyResolved) return;

          if (waitForReady) {
            const pattern = typeof waitForReady === 'string'
              ? new RegExp(waitForReady, 'i')
              : waitForReady;

            if (pattern.test(line)) {
              readyResolved = true;
              if (readyTimeout) clearTimeout(readyTimeout);
              info.status = 'running';
              this.logger.log(`Process ${id} is ready (matched: ${waitForReady})`);
              resolve({
                success: true,
                processId: id,
                pid: proc.pid,
                port,
                url: info.url,
                logs: [...logs],
              });
            }
          }
        };

        // Handle stdout
        proc.stdout?.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            addLog(`[stdout] ${line}`);
            checkReady(line);
          }
        });

        // Handle stderr
        proc.stderr?.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            addLog(`[stderr] ${line}`);
            checkReady(line);
          }
        });

        // Handle process exit
        proc.on('exit', (code, signal) => {
          const exitMsg = `Process exited with code ${code}, signal ${signal}`;
          addLog(`[system] ${exitMsg}`);

          info.status = code === 0 ? 'stopped' : 'failed';
          this.processes.delete(id);
          this.events.emit(`exit:${id}`, { code, signal });

          if (!readyResolved) {
            readyResolved = true;
            if (readyTimeout) clearTimeout(readyTimeout);
            resolve({
              success: false,
              processId: id,
              error: `Process exited before ready: ${exitMsg}`,
              logs: [...logs],
            });
          }
        });

        // Handle process error
        proc.on('error', (error) => {
          const errMsg = `Process error: ${error.message}`;
          addLog(`[error] ${errMsg}`);
          info.status = 'failed';

          if (!readyResolved) {
            readyResolved = true;
            if (readyTimeout) clearTimeout(readyTimeout);
            resolve({
              success: false,
              processId: id,
              error: errMsg,
              logs: [...logs],
            });
          }
        });

        // If no waitForReady, resolve after a short delay to capture initial logs
        if (!waitForReady) {
          setTimeout(() => {
            if (!readyResolved) {
              readyResolved = true;
              info.status = 'running';
              resolve({
                success: true,
                processId: id,
                pid: proc.pid,
                port,
                url: info.url,
                logs: [...logs],
              });
            }
          }, 1000); // Give it 1 second to capture initial output
        } else {
          // Set timeout for ready signal
          readyTimeout = setTimeout(() => {
            if (!readyResolved) {
              readyResolved = true;
              info.status = 'running'; // Assume running even if no ready signal
              this.logger.warn(`Process ${id} ready timeout, assuming running`);
              resolve({
                success: true,
                processId: id,
                pid: proc.pid,
                port,
                url: info.url,
                logs: [...logs],
              });
            }
          }, waitTimeoutMs);
        }

      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to start process: ${errMsg}`);
        resolve({
          success: false,
          error: errMsg,
          logs,
        });
      }
    });
  }

  /**
   * Stop a running process
   */
  async stopProcess(processId: string): Promise<{ success: boolean; logs: string[]; error?: string }> {
    const entry = this.processes.get(processId);

    if (!entry) {
      return { success: false, logs: [], error: `Process ${processId} not found` };
    }

    const { info, process: proc } = entry;
    const logs = [...info.logs];

    this.logger.log(`Stopping process ${processId} (PID: ${info.pid})`);

    return new Promise((resolve) => {
      try {
        // Try graceful shutdown first (SIGTERM)
        if (proc.pid) {
          try {
            process.kill(-proc.pid, 'SIGTERM');
          } catch {
            // Process group kill failed, try direct kill
            proc.kill('SIGTERM');
          }
        }

        // Wait for graceful shutdown
        const timeout = setTimeout(() => {
          // Force kill if still running
          try {
            if (proc.pid) {
              process.kill(-proc.pid, 'SIGKILL');
            }
          } catch {
            proc.kill('SIGKILL');
          }
        }, 5000);

        proc.on('exit', () => {
          clearTimeout(timeout);
          info.status = 'stopped';
          this.processes.delete(processId);
          logs.push('[system] Process stopped');
          resolve({ success: true, logs });
        });

        // If already dead, resolve immediately
        if (proc.killed || !proc.pid) {
          clearTimeout(timeout);
          this.processes.delete(processId);
          resolve({ success: true, logs });
        }

      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to stop process ${processId}: ${errMsg}`);
        this.processes.delete(processId);
        resolve({ success: false, logs, error: errMsg });
      }
    });
  }

  /**
   * Get info about a running process
   */
  getProcess(processId: string): ProcessInfo | null {
    const entry = this.processes.get(processId);
    return entry ? { ...entry.info, logs: [...entry.info.logs] } : null;
  }

  /**
   * Get logs for a process
   */
  getProcessLogs(processId: string, tailLines?: number): string[] {
    const entry = this.processes.get(processId);
    if (!entry) return [];

    const logs = entry.info.logs;
    if (tailLines && tailLines < logs.length) {
      return logs.slice(-tailLines);
    }
    return [...logs];
  }

  /**
   * List all running processes
   */
  listProcesses(): ProcessInfo[] {
    return Array.from(this.processes.values()).map(({ info }) => ({
      ...info,
      logs: [...info.logs],
    }));
  }

  /**
   * Check if a process is running
   */
  isRunning(processId: string): boolean {
    const entry = this.processes.get(processId);
    return entry?.info.status === 'running' || entry?.info.status === 'starting';
  }

  /**
   * Subscribe to log events for a process
   */
  onLog(processId: string, callback: (line: string) => void): () => void {
    this.events.on(`log:${processId}`, callback);
    return () => this.events.off(`log:${processId}`, callback);
  }

  /**
   * Subscribe to exit events for a process
   */
  onExit(processId: string, callback: (info: { code: number | null; signal: string | null }) => void): () => void {
    this.events.on(`exit:${processId}`, callback);
    return () => this.events.off(`exit:${processId}`, callback);
  }
}
