/**
 * TRANSCRIPTION SERVICE – Transcribes audio files using Groq's Whisper API.
 * Used primarily for voice messages from Telegram.
 */
import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import * as fs from 'fs';

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private groq: Groq | null = null;

  constructor() {
    if (process.env.GROQ_API_KEY) {
      this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      this.logger.log('Groq transcription service initialized');
    } else {
      this.logger.warn('GROQ_API_KEY not set, voice transcription will be disabled');
    }
  }

  /**
   * Check if transcription is available
   */
  isAvailable(): boolean {
    return this.groq !== null;
  }

  /**
   * Transcribe an audio file using Groq's Whisper model
   * @param filePath - Path to the audio file
   * @returns Transcription result with text and metadata
   */
  async transcribe(filePath: string): Promise<TranscriptionResult> {
    if (!this.groq) {
      throw new Error('Transcription service not available - GROQ_API_KEY not configured');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`Audio file not found: ${filePath}`);
    }

    this.logger.debug(`Transcribing audio file: ${filePath}`);

    try {
      const transcription = await this.groq.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-large-v3-turbo',
        temperature: 0,
        response_format: 'verbose_json',
      });

      this.logger.debug(`Transcription complete: ${transcription.text.slice(0, 100)}...`);

      // verbose_json format includes additional metadata
      const result = transcription as { text: string; language?: string; duration?: number };

      return {
        text: result.text,
        language: result.language,
        duration: result.duration,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Transcription failed: ${errorMsg}`);
      throw new Error(`Failed to transcribe audio: ${errorMsg}`);
    }
  }
}
