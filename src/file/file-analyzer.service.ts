/**
 * FILE ANALYZER SERVICE – Analyze files using vision model and text extraction.
 * Uses GPT-4o-mini for image analysis (following browser-tools.service.ts pattern).
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ModelFactoryService } from '../model/model-factory.service';
import { UsageService } from '../usage/usage.service';
import { FileService } from './file.service';
import { FileMetadata, FileAnalysisResult, categorizeFile } from './file.types';

@Injectable()
export class FileAnalyzerService {
  private readonly logger = new Logger(FileAnalyzerService.name);
  private visionModel: ChatOpenAI;

  constructor(
    @Inject(forwardRef(() => ModelFactoryService))
    private readonly modelFactory: ModelFactoryService,
    @Inject(forwardRef(() => UsageService))
    private readonly usageService: UsageService,
    private readonly fileService: FileService,
  ) {
    this.visionModel = this.modelFactory.getModel('vision');
  }

  /**
   * Analyze an image using the vision model
   */
  async analyzeImage(
    filePath: string,
    chatId: string,
    prompt?: string,
  ): Promise<FileAnalysisResult> {
    try {
      // Read image and convert to base64
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File not found' };
      }

      const imageBuffer = fs.readFileSync(filePath);
      const base64Image = imageBuffer.toString('base64');

      // Determine MIME type from extension
      const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
      const mimeTypes: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
      };
      const mimeType = mimeTypes[ext] || 'image/png';

      const systemPrompt = `You are an image analysis assistant. Analyze the provided image and respond helpfully based on the user's request. Be concise but thorough.`;

      const userPrompt =
        prompt ||
        'Describe this image in detail. What do you see? Include any text, objects, people, colors, and context.';

      const response = await this.visionModel.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage({
          content: [
            { type: 'text', text: userPrompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
              },
            },
          ],
        }),
      ]);

      // Record usage
      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      const analysis =
        typeof response.content === 'string' ? response.content : String(response.content);

      return {
        success: true,
        analysis,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Image analysis failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Extract text from a text-based file
   */
  async extractTextFromFile(filePath: string): Promise<FileAnalysisResult> {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File not found' };
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const textExtensions = ['txt', 'md', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts', 'py'];

      if (textExtensions.includes(ext)) {
        const text = fs.readFileSync(filePath, 'utf-8');
        return {
          success: true,
          extractedText: text.slice(0, 10000), // Limit to 10k chars
        };
      }

      // For other document types (PDF, Office), we'd need additional libraries
      // For now, return a placeholder
      return {
        success: false,
        error: `Text extraction not yet supported for .${ext} files. Use vision analysis for images.`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Analyze a file (dispatches to appropriate analyzer based on type)
   */
  async analyzeFile(
    chatId: string,
    fileId: string,
    analysisType?: 'vision' | 'text' | 'auto',
    customPrompt?: string,
  ): Promise<FileMetadata | null> {
    const metadata = this.fileService.getFile(chatId, fileId);
    if (!metadata) {
      this.logger.warn(`File not found: ${fileId}`);
      return null;
    }

    const filePath = this.fileService.getFilePath(chatId, fileId);
    if (!filePath) {
      this.logger.warn(`File path not found: ${fileId}`);
      return null;
    }

    // Update status to analyzing
    this.fileService.updateFileMetadata(chatId, fileId, {
      analysisStatus: 'analyzing',
    });

    let result: FileAnalysisResult;
    const type = analysisType || 'auto';

    // Determine analysis type based on file category
    if (type === 'auto') {
      if (metadata.category === 'image') {
        result = await this.analyzeImage(filePath, chatId, customPrompt);
      } else if (metadata.category === 'document') {
        // Try text extraction first
        result = await this.extractTextFromFile(filePath);
        // If text extraction failed and it's a document with images (like PDF), try vision
        if (!result.success && !result.extractedText) {
          result = await this.analyzeImage(filePath, chatId, customPrompt);
        }
      } else {
        result = {
          success: false,
          error: `Analysis not supported for ${metadata.category} files`,
        };
      }
    } else if (type === 'vision') {
      result = await this.analyzeImage(filePath, chatId, customPrompt);
    } else {
      result = await this.extractTextFromFile(filePath);
    }

    // Update metadata with results
    const updates: Partial<FileMetadata> = {
      analysisStatus: result.success ? 'completed' : 'failed',
      analyzedAt: new Date().toISOString(),
    };

    if (result.analysis) {
      updates.analysisResult = result.analysis;
    }
    if (result.extractedText) {
      updates.extractedText = result.extractedText;
    }

    return this.fileService.updateFileMetadata(chatId, fileId, updates);
  }

  /**
   * Generate tags from description using LLM
   */
  async generateTags(description: string, chatId: string): Promise<string[]> {
    try {
      const response = await this.visionModel.invoke([
        new SystemMessage(
          `You are a tagging assistant. Generate 3-5 relevant hashtags for the given description.
Return ONLY a JSON array of hashtags (without the # symbol), nothing else.
Example: ["invoice", "2024", "business", "expenses"]`,
        ),
        new HumanMessage(description),
      ]);

      if (AIMessage.isInstance(response)) {
        this.usageService.recordUsageFromResponse(chatId, response);
      }

      const content =
        typeof response.content === 'string' ? response.content : String(response.content);

      // Parse JSON array
      const match = content.match(/\[[\s\S]*\]/);
      if (match) {
        const tags: string[] = JSON.parse(match[0]);
        return tags.slice(0, 5).map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''));
      }

      return [];
    } catch (error) {
      this.logger.warn(`Failed to generate tags: ${error}`);
      return [];
    }
  }

  /**
   * Quick describe an image (short description for acknowledgment)
   */
  async quickDescribe(filePath: string, chatId: string): Promise<string> {
    const result = await this.analyzeImage(
      filePath,
      chatId,
      'Describe this image in one short sentence (max 20 words).',
    );
    return result.analysis || 'an image';
  }
}
