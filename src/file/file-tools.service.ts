/**
 * FILE TOOLS SERVICE – Agent tools for file operations.
 * Provides tools for listing, analyzing, searching, and managing files.
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { tool } from '@langchain/core/tools';
import * as z from 'zod';
import { FileService } from './file.service';
import { FileAnalyzerService } from './file-analyzer.service';
import { LongTermMemoryService } from '../memory/longterm-memory.service';
import { IMessagingService, MESSAGING_SERVICE } from '../messaging/messaging.interface';
import { FileCategory, formatFileSize, FileMemoryEntry } from './file.types';

@Injectable()
export class FileToolsService {
  private readonly logger = new Logger(FileToolsService.name);

  constructor(
    private readonly fileService: FileService,
    private readonly fileAnalyzer: FileAnalyzerService,
    @Inject(forwardRef(() => LongTermMemoryService))
    private readonly longTermMemory: LongTermMemoryService,
    @Inject(MESSAGING_SERVICE)
    private readonly messagingService: IMessagingService,
  ) { }

  /**
   * Get all file-related tools for a specific chat
   */
  getToolsForChat(chatId: string): Record<string, ReturnType<typeof tool>> {
    return {
      listFiles: this.createListFilesTool(chatId),
      getFileInfo: this.createGetFileInfoTool(chatId),
      analyzeFile: this.createAnalyzeFileTool(chatId),
      searchFiles: this.createSearchFilesTool(chatId),
      deleteFile: this.createDeleteFileTool(chatId),
      memorizeFile: this.createMemorizeFileTool(chatId),
      searchMemorizedFiles: this.createSearchMemorizedFilesTool(chatId),
      sendStoredFile: this.createSendStoredFileTool(chatId),
    };
  }

  /**
   * List files tool
   */
  private createListFilesTool(chatId: string) {
    return tool(
      async (input: { category?: string; limit?: number; memorizedOnly?: boolean }) => {
        const files = this.fileService.listFiles(chatId, {
          category: input.category as FileCategory | undefined,
          limit: input.limit ?? 20,
          memorizedOnly: input.memorizedOnly,
        });

        if (files.length === 0) {
          return input.memorizedOnly
            ? 'No memorized files found.'
            : 'No files stored yet.';
        }

        const stats = this.fileService.getStats(chatId);
        const fileList = files
          .map((f, i) => {
            const memorized = f.memorized ? ' [memorized]' : '';
            const analyzed = f.analysisStatus === 'completed' ? ' [analyzed]' : '';
            return `${i + 1}. ${f.originalName} (${f.category}, ${formatFileSize(f.size)})${memorized}${analyzed}\n   ID: ${f.id}`;
          })
          .join('\n');

        return `Files (${files.length}/${stats.totalFiles} total, ${formatFileSize(stats.totalSize)} used):\n\n${fileList}`;
      },
      {
        name: 'listFiles',
        description:
          'List stored files for this user. Can filter by category (image, document, audio, video, archive) and show only memorized files.',
        schema: z.object({
          category: z
            .string()
            .optional()
            .describe('Filter by category: image, document, audio, video, archive'),
          limit: z.number().optional().describe('Maximum number of files to return (default: 20)'),
          memorizedOnly: z.boolean().optional().describe('Only show memorized files'),
        }),
      },
    );
  }

  /**
   * Get file info tool
   */
  private createGetFileInfoTool(chatId: string) {
    return tool(
      async (input: { fileId: string }) => {
        const file = this.fileService.getFile(chatId, input.fileId);

        if (!file) {
          return `File not found: ${input.fileId}`;
        }

        const info = [
          `Name: ${file.originalName}`,
          `Type: ${file.mimeType} (${file.category})`,
          `Size: ${formatFileSize(file.size)}`,
          `Uploaded: ${new Date(file.uploadedAt).toLocaleString()}`,
          `Memorized: ${file.memorized ? 'Yes' : 'No'}`,
          `Analysis: ${file.analysisStatus}`,
        ];

        if (file.caption) {
          info.push(`Caption: ${file.caption}`);
        }
        if (file.tags?.length) {
          info.push(`Tags: ${file.tags.map((t) => `#${t}`).join(' ')}`);
        }
        if (file.analysisResult) {
          info.push(`Analysis result: ${file.analysisResult.slice(0, 500)}...`);
        }

        return info.join('\n');
      },
      {
        name: 'getFileInfo',
        description: 'Get detailed information about a specific file by its ID.',
        schema: z.object({
          fileId: z.string().describe('The file ID'),
        }),
      },
    );
  }

  /**
   * Analyze file tool
   */
  private createAnalyzeFileTool(chatId: string) {
    return tool(
      async (input: { fileId: string; prompt?: string }) => {
        const file = this.fileService.getFile(chatId, input.fileId);

        if (!file) {
          return `File not found: ${input.fileId}`;
        }

        if (file.category !== 'image' && file.category !== 'document') {
          return `Analysis not supported for ${file.category} files. Only images and documents can be analyzed.`;
        }

        const result = await this.fileAnalyzer.analyzeFile(
          chatId,
          input.fileId,
          'auto',
          input.prompt,
        );

        if (!result) {
          return 'Analysis failed. File may not exist or be inaccessible.';
        }

        if (result.analysisStatus === 'completed') {
          return `Analysis of "${file.originalName}":\n\n${result.analysisResult || result.extractedText || 'No content extracted.'}`;
        }

        return `Analysis failed for "${file.originalName}".`;
      },
      {
        name: 'analyzeFile',
        description:
          'Analyze a file using AI vision (for images) or text extraction (for documents). Optionally provide a custom prompt.',
        schema: z.object({
          fileId: z.string().describe('The file ID to analyze'),
          prompt: z
            .string()
            .optional()
            .describe('Custom analysis prompt (e.g., "Extract all text from this receipt")'),
        }),
      },
    );
  }

  /**
   * Search files tool
   */
  private createSearchFilesTool(chatId: string) {
    return tool(
      async (input: { query: string }) => {
        const files = this.fileService.searchFiles(chatId, input.query);

        if (files.length === 0) {
          return `No files found matching "${input.query}".`;
        }

        const results = files
          .map((f, i) => {
            const memorized = f.memorized ? ' [memorized]' : '';
            return `${i + 1}. ${f.originalName}${memorized} (${f.category})\n   ID: ${f.id}`;
          })
          .join('\n');

        return `Found ${files.length} file(s) matching "${input.query}":\n\n${results}`;
      },
      {
        name: 'searchFiles',
        description: 'Search files by name, tags, or content (if analyzed).',
        schema: z.object({
          query: z.string().describe('Search query'),
        }),
      },
    );
  }

  /**
   * Delete file tool
   */
  private createDeleteFileTool(chatId: string) {
    return tool(
      async (input: { fileId: string }) => {
        const file = this.fileService.getFile(chatId, input.fileId);

        if (!file) {
          return `File not found: ${input.fileId}`;
        }

        const fileName = file.originalName;
        const success = this.fileService.deleteFile(chatId, input.fileId);

        if (success) {
          return `Successfully deleted "${fileName}".`;
        }

        return `Failed to delete "${fileName}".`;
      },
      {
        name: 'deleteFile',
        description: 'Delete a stored file by its ID.',
        schema: z.object({
          fileId: z.string().describe('The file ID to delete'),
        }),
      },
    );
  }

  /**
   * Memorize file tool - saves file to long-term memory
   */
  private createMemorizeFileTool(chatId: string) {
    return tool(
      async (input: { fileId: string; description: string; tags?: string[] }) => {
        const file = this.fileService.getFile(chatId, input.fileId);

        if (!file) {
          return `File not found: ${input.fileId}`;
        }

        if (file.memorized) {
          return `File "${file.originalName}" is already memorized.`;
        }

        // Generate tags if not provided
        let tags = input.tags || [];
        if (tags.length === 0) {
          tags = await this.fileAnalyzer.generateTags(input.description, chatId);
        }

        // Create long-term memory entry
        const memoryEntry = await this.longTermMemory.addMemory(chatId, {
          category: 'file',
          content: input.description,
          source: 'manual', // User explicitly asked to memorize
          tags,
          metadata: {
            fileId: file.id,
            fileName: file.originalName,
            filePath: file.localPath,
            mimeType: file.mimeType,
            size: file.size,
            uploadedAt: file.uploadedAt,
            memorizedAt: new Date().toISOString(),
          },
        });

        // Update file metadata
        this.fileService.updateFileMetadata(chatId, input.fileId, {
          memorized: true,
          memoryId: memoryEntry.id,
          tags,
        });

        this.fileService.markAsMemorized(chatId, input.fileId, memoryEntry.id);

        const tagList = tags.length > 0 ? `\nTags: ${tags.map((t) => `#${t}`).join(' ')}` : '';

        return `Memorized "${file.originalName}"!\n\nDescription: ${input.description}${tagList}\n\nYou can find this file later by asking about "${input.description}" or using the tags.`;
      },
      {
        name: 'memorizeFile',
        description:
          'Save a file to long-term memory with a description and tags. The user can later find this file by asking about it.',
        schema: z.object({
          fileId: z.string().describe('The file ID to memorize'),
          description: z.string().describe("User's description of what this file is about"),
          tags: z
            .array(z.string())
            .optional()
            .describe('Hashtags for the file (auto-generated if not provided)'),
        }),
      },
    );
  }

  /**
   * Search memorized files tool - searches long-term memory for files
   */
  private createSearchMemorizedFilesTool(chatId: string) {
    return tool(
      async (input: { query: string }) => {
        // Get all file memories from long-term memory
        const allMemories = await this.longTermMemory.getMemories(chatId);

        // Filter to only file memories and search by keyword
        const queryLower = input.query.toLowerCase();
        const fileMemories = allMemories.filter((m) => {
          if (m.category !== 'file' && !m.metadata?.fileId) {
            return false;
          }
          // Check if query matches content or tags
          const contentMatch = m.content.toLowerCase().includes(queryLower);
          const tagMatch = m.tags?.some((t) => t.toLowerCase().includes(queryLower));
          const fileNameMatch = m.metadata?.fileName?.toLowerCase().includes(queryLower);
          return contentMatch || tagMatch || fileNameMatch;
        });

        if (fileMemories.length === 0) {
          return `No memorized files found matching "${input.query}".`;
        }

        const results = fileMemories
          .map((m, i) => {
            const fileName = m.metadata?.fileName || 'Unknown';
            const tags = m.tags?.length ? m.tags.map((t) => `#${t}`).join(' ') : '';
            return `${i + 1}. ${fileName}\n   Description: ${m.content}\n   ${tags}\n   File ID: ${m.metadata?.fileId}`;
          })
          .join('\n\n');

        return `Found ${fileMemories.length} memorized file(s) matching "${input.query}":\n\n${results}\n\n💡 Use sendStoredFile with the file ID to send a file back to the user.`;
      },
      {
        name: 'searchMemorizedFiles',
        description:
          'Search for files in long-term memory by description or tags. Use this when user asks "Do you remember the file about..." or "Find the document I saved about..."',
        schema: z.object({
          query: z.string().describe('Search query (description or tag)'),
        }),
      },
    );
  }

  /**
   * Send a stored file back to the user
   * Returns [content, artifact] where artifact contains sent file info for memory recording
   */
  private createSendStoredFileTool(chatId: string) {
    return tool(
      async (input: { fileId: string; caption?: string }): Promise<[string, { sentFile?: { fileId: string; fileName: string; filePath: string; mimeType: string } }]> => {
        // Get file metadata
        const file = this.fileService.getFile(chatId, input.fileId);

        if (!file) {
          return [`File not found with ID: ${input.fileId}. Use listFiles or searchMemorizedFiles to find the correct file ID.`, {}];
        }

        // Get the actual file path
        const filePath = this.fileService.getFilePath(chatId, input.fileId);

        if (!filePath) {
          return [`File exists in metadata but the actual file is missing: ${file.originalName}`, {}];
        }

        // Determine caption
        const caption = input.caption || file.originalName;

        try {
          // Send based on file category
          if (file.category === 'image') {
            const result = await this.messagingService.sendPhoto(chatId, filePath, caption);
            if (result.success) {
              this.logger.log(`Sent photo ${file.originalName} to chat ${chatId}`);
              // Return content and artifact with file info for memory recording
              return [
                `✅ Sent photo "${file.originalName}" to the user. [File: ${file.originalName}, ID: ${file.id}, Path: ${file.localPath}]`,
                {
                  sentFile: {
                    fileId: file.id,
                    fileName: file.originalName,
                    filePath: file.localPath,
                    mimeType: file.mimeType,
                  },
                },
              ];
            } else {
              return [`Failed to send photo: ${result.error}`, {}];
            }
          } else {
            // For non-image files, we need to use document sending
            // For now, return an informative message
            return [`File "${file.originalName}" is a ${file.category} file. Currently, only images can be sent directly. The file is stored at: ${file.localPath}`, {}];
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to send file ${file.originalName}: ${errorMsg}`);
          return [`Error sending file: ${errorMsg}`, {}];
        }
      },
      {
        name: 'sendStoredFile',
        responseFormat: 'content_and_artifact' as const,
        description: `Send a stored file (photo, document, etc.) back to the user. Use this when:
- The user asks to see a file they previously sent ("show me that photo", "send the image")
- The user asks for a memorized file ("send me Touraj's photo", "show the receipt")
- You found a file via searchMemorizedFiles and want to send it

IMPORTANT: You need the file ID to send a file. Get it from:
- searchMemorizedFiles (returns file IDs in the results)
- listFiles (shows file IDs)
- The reply context when user replies to a file message

Example flow:
1. User: "Send me Touraj's photo"
2. Call searchMemorizedFiles with query "Touraj" to find the file ID
3. Call sendStoredFile with the file ID to send it`,
        schema: z.object({
          fileId: z.string().describe('The file ID to send (get from searchMemorizedFiles, listFiles, or reply context)'),
          caption: z.string().optional().describe('Optional caption for the file (defaults to filename)'),
        }),
      },
    );
  }
}
