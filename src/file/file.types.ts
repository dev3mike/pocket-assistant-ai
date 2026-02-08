/**
 * FILE TYPES – Interfaces and types for file handling system.
 * Supports images, documents, audio, video, and archives.
 */

// File categories based on MIME type groups
export type FileCategory = 'image' | 'document' | 'audio' | 'video' | 'archive' | 'other';

// File analysis status
export type AnalysisStatus = 'pending' | 'analyzing' | 'completed' | 'failed' | 'skipped';

// Individual file metadata
export interface FileMetadata {
  id: string;                     // Internal unique ID (UUID)
  telegramFileId: string;         // Telegram's file_id for re-downloading
  telegramFileUniqueId: string;   // Telegram's unique_id (persistent across bots)

  // File info
  originalName: string;           // Original filename from user
  mimeType: string;               // MIME type
  category: FileCategory;         // Derived category
  size: number;                   // File size in bytes
  extension: string;              // File extension (without dot)

  // Storage paths (relative to data/{chatId}/files/)
  localPath: string;              // Path to original file
  thumbnailPath?: string;         // Path to thumbnail if generated

  // Timestamps
  uploadedAt: string;             // ISO timestamp when received
  analyzedAt?: string;            // ISO timestamp when analyzed
  lastAccessedAt?: string;        // ISO timestamp last accessed
  expiresAt?: string;             // ISO timestamp for auto-cleanup

  // Analysis
  analysisStatus: AnalysisStatus;
  analysisResult?: string;        // Vision/content analysis result
  extractedText?: string;         // OCR or text extraction result

  // Context
  caption?: string;               // User-provided caption
  messageId?: number;             // Telegram message ID for reference

  // Tags and metadata
  tags?: string[];                // User or AI-assigned tags
  userNotes?: string;             // User-added notes

  // Memory reference
  memorized?: boolean;            // Whether file is saved to long-term memory
  memoryId?: string;              // Reference to long-term memory entry
}

// File registry for a chat
export interface FileStore {
  chatId: string;
  files: FileMetadata[];
  lastUpdated: string;
  totalSize: number;              // Total bytes stored
  fileCount: number;              // Number of files
}

// File analysis request
export interface FileAnalysisRequest {
  fileId: string;
  analysisType: 'vision' | 'ocr' | 'content' | 'summary';
  prompt?: string;                // Custom analysis prompt
}

// File analysis result
export interface FileAnalysisResult {
  success: boolean;
  analysis?: string;
  extractedText?: string;
  error?: string;
}

// File upload limits
export interface FileLimits {
  maxFileSize: number;            // Max single file size (bytes)
  maxTotalStorage: number;        // Max storage per chat (bytes)
  maxFileCount: number;           // Max files per chat
  allowedMimeTypes: string[];     // Whitelist of allowed MIME types
  retentionDays: number;          // Auto-delete after days
}

// Default file limits
export const DEFAULT_FILE_LIMITS: FileLimits = {
  maxFileSize: 20 * 1024 * 1024,       // 20 MB (Telegram bot limit)
  maxTotalStorage: 500 * 1024 * 1024,  // 500 MB per chat
  maxFileCount: 500,                   // Max 500 files per chat
  allowedMimeTypes: [
    // Images
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
    'image/tiff',
    // Documents
    'application/pdf',
    'text/plain',
    'text/csv',
    'text/markdown',
    'text/html',
    'application/json',
    'application/xml',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Audio
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/m4a',
    'audio/aac',
    'audio/flac',
    // Video
    'video/mp4',
    'video/mpeg',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    // Archives
    'application/zip',
    'application/x-tar',
    'application/gzip',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
  ],
  retentionDays: 30,
};

// MIME type to category mapping
export function categorizeFile(mimeType: string): FileCategory {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (
    mimeType.startsWith('application/zip') ||
    mimeType.includes('tar') ||
    mimeType.includes('gzip') ||
    mimeType.includes('rar') ||
    mimeType.includes('7z')
  ) {
    return 'archive';
  }
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/pdf' ||
    mimeType.includes('document') ||
    mimeType.includes('spreadsheet') ||
    mimeType.includes('presentation') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  ) {
    return 'document';
  }
  return 'other';
}

// Get file extension from filename or MIME type
export function getFileExtension(fileName: string, mimeType?: string): string {
  // Try to get from filename first
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex > 0) {
    return fileName.slice(dotIndex + 1).toLowerCase();
  }

  // Fallback to MIME type mapping
  const mimeExtensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/json': 'json',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'application/zip': 'zip',
  };

  return mimeType ? (mimeExtensions[mimeType] || 'bin') : 'bin';
}

// Sanitize filename for storage
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')  // Replace special chars
    .replace(/\.{2,}/g, '.')            // No double dots
    .replace(/^\.+|\.+$/g, '')          // No leading/trailing dots
    .slice(0, 200);                     // Max length
}

// Check for dangerous path patterns
export function containsDangerousPatterns(path: string): boolean {
  const dangerous = ['../', '..\\', '~/', '%2e%2e', '\0', '\\0'];
  return dangerous.some((pattern) => path.toLowerCase().includes(pattern));
}

// Format file size for display
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// File memory entry (for long-term memory integration)
export interface FileMemoryEntry {
  category: 'file';               // Long-term memory category
  content: string;                // Description provided by user
  metadata: {
    fileId: string;
    fileName: string;
    filePath: string;
    mimeType: string;
    size: number;
    tags: string[];
    uploadedAt: string;
    memorizedAt: string;
  };
}
