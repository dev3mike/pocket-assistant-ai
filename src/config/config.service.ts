/**
 * App configuration (model names, vision model, allowed user IDs, logging flag).
 * Loaded from data/config.json and watched for changes. Used by agents and
 * services that need model or security settings; no flow logic.
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

export interface AppConfig {
  enableLogging: boolean;
  model: string;
  vision_model: string;
  coder_model: string;
  security: {
    allowedUserIds: string[];
  };
  /** Per-chat active coder project folder (chatId -> folder name under data/coder/) */
  coderActiveByChat?: Record<string, string>;
}

const DEFAULT_CONFIG: AppConfig = {
  enableLogging: false,
  model: 'google/gemini-3-flash-preview',
  vision_model: 'openai/gpt-4o-mini',
  coder_model: 'google/gemini-3-flash-preview',
  security: {
    allowedUserIds: [],
  },
  coderActiveByChat: {},
};

@Injectable()
export class ConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConfigService.name);
  private config: AppConfig = DEFAULT_CONFIG;
  private readonly configPath: string;
  private fileWatcher: fs.FSWatcher | null = null;
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private lastSaveTime = 0;

  constructor() {
    this.configPath = path.join(process.cwd(), 'data/config.json');
  }

  async onModuleInit() {
    await this.loadConfig();
    this.startFileWatcher();
  }

  async onModuleDestroy() {
    this.stopFileWatcher();
  }

  private startFileWatcher(): void {
    try {
      this.fileWatcher = fs.watch(this.configPath, (eventType) => {
        if (eventType === 'change') {
          if (this.reloadDebounceTimer) {
            clearTimeout(this.reloadDebounceTimer);
          }

          this.reloadDebounceTimer = setTimeout(() => {
            if (Date.now() - this.lastSaveTime < 1000) {
              return;
            }
            this.reloadConfig();
          }, 100);
        }
      });

      this.logger.log('Config file watcher started - changes will be auto-reloaded');
    } catch (error) {
      this.logger.warn(`Could not start config file watcher: ${error}`);
    }
  }

  private stopFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
  }

  private async reloadConfig(): Promise<void> {
    const oldAllowedUsers = [...this.config.security.allowedUserIds];

    await this.loadConfig();

    const newAllowedUsers = this.config.security.allowedUserIds;
    const added = newAllowedUsers.filter((id) => !oldAllowedUsers.includes(id));
    const removed = oldAllowedUsers.filter((id) => !newAllowedUsers.includes(id));

    if (added.length > 0) {
      this.logger.log(`Users added to allowed list: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      this.logger.log(`Users removed from allowed list: ${removed.join(', ')}`);
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const exists = await fsPromises.access(this.configPath).then(() => true).catch(() => false);
      if (exists) {
        const data = await fsPromises.readFile(this.configPath, 'utf-8');
        const loaded = JSON.parse(data);
        this.config = {
          enableLogging: loaded.enableLogging ?? DEFAULT_CONFIG.enableLogging,
          model: loaded.model ?? DEFAULT_CONFIG.model,
          vision_model: loaded.vision_model ?? DEFAULT_CONFIG.vision_model,
          coder_model: loaded.coder_model ?? DEFAULT_CONFIG.coder_model,
          security: { ...DEFAULT_CONFIG.security, ...loaded.security },
          coderActiveByChat: loaded.coderActiveByChat != null && typeof loaded.coderActiveByChat === 'object'
            ? { ...loaded.coderActiveByChat }
            : DEFAULT_CONFIG.coderActiveByChat,
        };
        this.logger.log('Configuration loaded from config.json');
      } else {
        await this.saveConfig();
        this.logger.log('Created default config.json');
      }
    } catch (error) {
      this.logger.warn(`Failed to load config, using defaults: ${error}`);
      this.config = DEFAULT_CONFIG;
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      this.lastSaveTime = Date.now();
      await fsPromises.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      this.logger.error(`Failed to save config: ${error}`);
    }
  }

  async manualReload(): Promise<void> {
    await this.reloadConfig();
    this.logger.log('Configuration manually reloaded');
  }

  getConfig(): AppConfig {
    return this.config;
  }

  // ===== Logging =====

  isLoggingEnabled(): boolean {
    return this.config.enableLogging;
  }

  async setLoggingEnabled(enabled: boolean): Promise<void> {
    this.config.enableLogging = enabled;
    await this.saveConfig();
    this.logger.log(`Logging ${enabled ? 'enabled' : 'disabled'}`);
  }

  // ===== Security =====

  isUserAllowed(userId: string): boolean {
    if (this.config.security.allowedUserIds.length === 0) {
      return false;
    }
    return this.config.security.allowedUserIds.includes(userId);
  }

  getAllowedUserIds(): string[] {
    return this.config.security.allowedUserIds;
  }

  async addAllowedUser(userId: string): Promise<void> {
    if (!this.config.security.allowedUserIds.includes(userId)) {
      this.config.security.allowedUserIds.push(userId);
      await this.saveConfig();
      this.logger.log(`User ${userId} added to allowed list`);
    }
  }

  async removeAllowedUser(userId: string): Promise<void> {
    const index = this.config.security.allowedUserIds.indexOf(userId);
    if (index > -1) {
      this.config.security.allowedUserIds.splice(index, 1);
      await this.saveConfig();
      this.logger.log(`User ${userId} removed from allowed list`);
    }
  }

  // ===== Coder active folder (per chat) =====

  getCoderActiveFolder(chatId: string): string | null {
    const map = this.config.coderActiveByChat ?? {};
    const folder = map[chatId];
    return folder && typeof folder === 'string' ? folder : null;
  }

  async setCoderActiveFolder(chatId: string, folder: string): Promise<void> {
    const map = this.config.coderActiveByChat ?? {};
    this.config.coderActiveByChat = { ...map, [chatId]: folder };
    await this.saveConfig();
    this.logger.debug(`Coder active folder for ${chatId} set to ${folder}`);
  }

  /**
   * List all project folders under data/coder/
   * Returns folder names with basic metadata (exists, has files)
   */
  async listCoderProjects(): Promise<Array<{ name: string; path: string }>> {
    const coderDir = path.join(process.cwd(), 'data/coder');
    try {
      const exists = await fsPromises.access(coderDir).then(() => true).catch(() => false);
      if (!exists) {
        return [];
      }
      const entries = await fsPromises.readdir(coderDir, { withFileTypes: true });
      const folders = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: path.join(coderDir, entry.name),
        }));
      return folders;
    } catch (error) {
      this.logger.warn(`Failed to list coder projects: ${error}`);
      return [];
    }
  }

  /**
   * Check if a coder project folder exists
   */
  async coderProjectExists(folderName: string): Promise<boolean> {
    const projectPath = path.join(process.cwd(), 'data/coder', folderName);
    try {
      const stat = await fsPromises.stat(projectPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
