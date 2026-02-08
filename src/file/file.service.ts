/**
 * FILE SERVICE – Core file operations for downloading, storing, and managing files.
 * Handles file reception from Telegram, local storage, and metadata management.
 */
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import {
  FileMetadata,
  FileStore,
  FileCategory,
  FileLimits,
  DEFAULT_FILE_LIMITS,
  categorizeFile,
  getFileExtension,
  sanitizeFileName,
  containsDangerousPatterns,
  formatFileSize,
} from './file.types';

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);
  private readonly dataDir: string;
  private readonly limits: FileLimits;

  // In-memory cache for file stores
  private cache: Map<string, FileStore> = new Map();

  constructor() {
    this.dataDir = path.join(process.cwd(), 'data');
    this.limits = DEFAULT_FILE_LIMITS;
  }

  /**
   * Get the files directory for a chat
   */
  private getFilesDir(chatId: string): string {
    return path.join(this.dataDir, chatId, 'files');
  }

  /**
   * Get the file store path for a chat
   */
  private getStorePath(chatId: string): string {
    return path.join(this.dataDir, chatId, 'files.json');
  }

  /**
   * Generate a unique file ID
   */
  private generateId(): string {
    return crypto.randomBytes(12).toString('hex');
  }

  /**
   * Load file store for a chat
   */
  private loadStore(chatId: string): FileStore {
    if (this.cache.has(chatId)) {
      return this.cache.get(chatId)!;
    }

    const storePath = this.getStorePath(chatId);

    try {
      if (fs.existsSync(storePath)) {
        const content = fs.readFileSync(storePath, 'utf-8');
        const store: FileStore = JSON.parse(content);
        this.cache.set(chatId, store);
        return store;
      }
    } catch (error) {
      this.logger.error(`Failed to load file store for ${chatId}: ${error}`);
    }

    // Return empty store if not found
    const emptyStore: FileStore = {
      chatId,
      files: [],
      lastUpdated: new Date().toISOString(),
      totalSize: 0,
      fileCount: 0,
    };
    this.cache.set(chatId, emptyStore);
    return emptyStore;
  }

  /**
   * Save file store to disk
   */
  private saveStore(chatId: string, store: FileStore): void {
    try {
      const chatDir = path.join(this.dataDir, chatId);
      if (!fs.existsSync(chatDir)) {
        fs.mkdirSync(chatDir, { recursive: true });
      }

      store.lastUpdated = new Date().toISOString();
      store.fileCount = store.files.length;
      store.totalSize = store.files.reduce((sum, f) => sum + f.size, 0);

      const storePath = this.getStorePath(chatId);
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

      this.cache.set(chatId, store);
    } catch (error) {
      this.logger.error(`Failed to save file store for ${chatId}: ${error}`);
    }
  }

  /**
   * Ensure file directory exists
   */
  private ensureFileDir(chatId: string, fileId: string): string {
    const fileDir = path.join(this.getFilesDir(chatId), fileId);
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }
    return fileDir;
  }

  /**
   * Validate file path is within allowed directory (security check)
   */
  private validatePath(chatId: string, filePath: string): boolean {
    const allowedBase = path.resolve(this.dataDir, chatId);
    const resolvedPath = path.resolve(filePath);
    return resolvedPath.startsWith(allowedBase);
  }

  /**
   * Check if MIME type is allowed
   */
  isAllowedMimeType(mimeType: string): boolean {
    // Also allow generic types that match allowed patterns
    if (this.limits.allowedMimeTypes.includes(mimeType)) {
      return true;
    }
    // Allow application/octet-stream as fallback (Telegram sometimes uses this)
    if (mimeType === 'application/octet-stream') {
      return true;
    }
    return false;
  }

  /**
   * Check storage limits for a chat
   */
  checkStorageLimits(
    chatId: string,
    newFileSize = 0,
  ): { allowed: boolean; message?: string } {
    const store = this.loadStore(chatId);

    // Check file count
    if (store.fileCount >= this.limits.maxFileCount) {
      return {
        allowed: false,
        message: `Maximum file limit reached (${this.limits.maxFileCount} files). Please delete some files first.`,
      };
    }

    // Check single file size
    if (newFileSize > this.limits.maxFileSize) {
      return {
        allowed: false,
        message: `File too large. Maximum size: ${formatFileSize(this.limits.maxFileSize)}`,
      };
    }

    // Check total storage
    if (store.totalSize + newFileSize > this.limits.maxTotalStorage) {
      return {
        allowed: false,
        message: `Storage limit reached (${formatFileSize(this.limits.maxTotalStorage)}). Please delete some files first.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Download file from URL and save locally
   */
  private async downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const file = fs.createWriteStream(destPath);
      protocol
        .get(url, (response) => {
          // Handle redirects
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              file.close();
              fs.unlinkSync(destPath);
              this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
              return;
            }
          }

          if (response.statusCode !== 200) {
            file.close();
            fs.unlinkSync(destPath);
            reject(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }

          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        })
        .on('error', (err) => {
          file.close();
          if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
          }
          reject(err);
        });
    });
  }

  /**
   * Download and store a file from Telegram
   */
  async downloadAndStore(
    chatId: string,
    telegramFileId: string,
    telegramFileUniqueId: string,
    telegramFileUrl: string,
    fileName: string,
    mimeType: string,
    size: number,
    caption?: string,
    messageId?: number,
  ): Promise<FileMetadata> {
    // Validate inputs
    if (containsDangerousPatterns(fileName)) {
      throw new Error('Invalid filename');
    }

    // Check limits
    const limitsCheck = this.checkStorageLimits(chatId, size);
    if (!limitsCheck.allowed) {
      throw new Error(limitsCheck.message);
    }

    // Generate IDs and paths
    const fileId = this.generateId();
    const sanitizedName = sanitizeFileName(fileName);
    const extension = getFileExtension(fileName, mimeType);
    const category = categorizeFile(mimeType);

    // Create file directory
    const fileDir = this.ensureFileDir(chatId, fileId);
    const localFileName = `original.${extension}`;
    const localPath = path.join(fileDir, localFileName);

    // Validate path security
    if (!this.validatePath(chatId, localPath)) {
      throw new Error('Invalid file path');
    }

    // Download file
    this.logger.log(`Downloading file ${sanitizedName} for chat ${chatId}`);
    await this.downloadFile(telegramFileUrl, localPath);

    // Verify file was downloaded
    if (!fs.existsSync(localPath)) {
      throw new Error('File download failed');
    }

    // Get actual file size
    const stats = fs.statSync(localPath);
    const actualSize = stats.size;

    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.limits.retentionDays);

    // Create metadata
    const metadata: FileMetadata = {
      id: fileId,
      telegramFileId,
      telegramFileUniqueId,
      originalName: sanitizedName,
      mimeType,
      category,
      size: actualSize,
      extension,
      localPath: `${fileId}/${localFileName}`,
      uploadedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      analysisStatus: 'pending',
      caption,
      messageId,
      memorized: false,
    };

    // Save to store
    const store = this.loadStore(chatId);
    store.files.push(metadata);
    this.saveStore(chatId, store);

    this.logger.log(
      `Stored file ${sanitizedName} (${formatFileSize(actualSize)}) for chat ${chatId}`,
    );

    return metadata;
  }

  /**
   * Get file metadata by ID
   */
  getFile(chatId: string, fileId: string): FileMetadata | null {
    const store = this.loadStore(chatId);
    return store.files.find((f) => f.id === fileId) || null;
  }

  /**
   * Get file by Telegram unique ID (useful for avoiding duplicates)
   */
  getFileByTelegramId(chatId: string, telegramUniqueId: string): FileMetadata | null {
    const store = this.loadStore(chatId);
    return store.files.find((f) => f.telegramFileUniqueId === telegramUniqueId) || null;
  }

  /**
   * List all files for a chat
   */
  listFiles(
    chatId: string,
    options?: {
      category?: FileCategory;
      limit?: number;
      offset?: number;
      memorizedOnly?: boolean;
    },
  ): FileMetadata[] {
    const store = this.loadStore(chatId);
    let files = [...store.files];

    // Filter by category
    if (options?.category) {
      files = files.filter((f) => f.category === options.category);
    }

    // Filter by memorized status
    if (options?.memorizedOnly) {
      files = files.filter((f) => f.memorized === true);
    }

    // Sort by upload date (newest first)
    files.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

    // Apply pagination
    if (options?.offset) {
      files = files.slice(options.offset);
    }
    if (options?.limit) {
      files = files.slice(0, options.limit);
    }

    return files;
  }

  /**
   * Get the local file path for reading
   */
  getFilePath(chatId: string, fileId: string): string | null {
    const metadata = this.getFile(chatId, fileId);
    if (!metadata) {
      return null;
    }

    const fullPath = path.join(this.getFilesDir(chatId), metadata.localPath);

    // Security check
    if (!this.validatePath(chatId, fullPath)) {
      return null;
    }

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      return null;
    }

    // Update last accessed time
    this.updateFileMetadata(chatId, fileId, {
      lastAccessedAt: new Date().toISOString(),
    });

    return fullPath;
  }

  /**
   * Update file metadata
   */
  updateFileMetadata(
    chatId: string,
    fileId: string,
    updates: Partial<FileMetadata>,
  ): FileMetadata | null {
    const store = this.loadStore(chatId);
    const fileIndex = store.files.findIndex((f) => f.id === fileId);

    if (fileIndex === -1) {
      return null;
    }

    // Apply updates (excluding immutable fields)
    const { id, telegramFileId, telegramFileUniqueId, uploadedAt, ...allowedUpdates } =
      updates as FileMetadata;
    Object.assign(store.files[fileIndex], allowedUpdates);

    this.saveStore(chatId, store);
    return store.files[fileIndex];
  }

  /**
   * Delete a file
   */
  deleteFile(chatId: string, fileId: string): boolean {
    const store = this.loadStore(chatId);
    const fileIndex = store.files.findIndex((f) => f.id === fileId);

    if (fileIndex === -1) {
      return false;
    }

    const metadata = store.files[fileIndex];

    // Delete file from disk
    const fileDir = path.join(this.getFilesDir(chatId), fileId);
    if (fs.existsSync(fileDir)) {
      fs.rmSync(fileDir, { recursive: true });
    }

    // Remove from store
    store.files.splice(fileIndex, 1);
    this.saveStore(chatId, store);

    this.logger.log(`Deleted file ${metadata.originalName} for chat ${chatId}`);
    return true;
  }

  /**
   * Search files by name or tags
   */
  searchFiles(chatId: string, query: string): FileMetadata[] {
    const store = this.loadStore(chatId);
    const normalizedQuery = query.toLowerCase();

    return store.files.filter((f) => {
      const nameMatch = f.originalName.toLowerCase().includes(normalizedQuery);
      const tagMatch = f.tags?.some((t) => t.toLowerCase().includes(normalizedQuery));
      const captionMatch = f.caption?.toLowerCase().includes(normalizedQuery);
      const analysisMatch = f.analysisResult?.toLowerCase().includes(normalizedQuery);
      return nameMatch || tagMatch || captionMatch || analysisMatch;
    });
  }

  /**
   * Cleanup expired files
   */
  cleanupExpiredFiles(chatId: string): number {
    const store = this.loadStore(chatId);
    const now = new Date();
    let deletedCount = 0;

    const expiredFiles = store.files.filter((f) => {
      if (!f.expiresAt) return false;
      // Don't delete memorized files
      if (f.memorized) return false;
      return new Date(f.expiresAt) < now;
    });

    for (const file of expiredFiles) {
      if (this.deleteFile(chatId, file.id)) {
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      this.logger.log(`Cleaned up ${deletedCount} expired files for chat ${chatId}`);
    }

    return deletedCount;
  }

  /**
   * Get storage statistics for a chat
   */
  getStats(chatId: string): {
    totalFiles: number;
    totalSize: number;
    byCategory: Record<FileCategory, number>;
    memorizedCount: number;
  } {
    const store = this.loadStore(chatId);
    const byCategory: Record<string, number> = {};
    let memorizedCount = 0;

    for (const file of store.files) {
      byCategory[file.category] = (byCategory[file.category] || 0) + 1;
      if (file.memorized) {
        memorizedCount++;
      }
    }

    return {
      totalFiles: store.fileCount,
      totalSize: store.totalSize,
      byCategory: byCategory as Record<FileCategory, number>,
      memorizedCount,
    };
  }

  /**
   * Mark a file as memorized
   */
  markAsMemorized(chatId: string, fileId: string, memoryId: string): boolean {
    const result = this.updateFileMetadata(chatId, fileId, {
      memorized: true,
      memoryId,
      // Remove expiry for memorized files
      expiresAt: undefined,
    });
    return result !== null;
  }

  /**
   * Get the most recent file (useful for context)
   */
  getMostRecentFile(chatId: string): FileMetadata | null {
    const files = this.listFiles(chatId, { limit: 1 });
    return files[0] || null;
  }
}
