/**
 * FILE MODULE – NestJS module for file handling system.
 */
import { Module, forwardRef } from '@nestjs/common';
import { FileService } from './file.service';
import { FileAnalyzerService } from './file-analyzer.service';
import { FileToolsService } from './file-tools.service';
import { ModelModule } from '../model/model.module';
import { UsageModule } from '../usage/usage.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [
    forwardRef(() => ModelModule),
    forwardRef(() => UsageModule),
    forwardRef(() => MemoryModule),
  ],
  providers: [FileService, FileAnalyzerService, FileToolsService],
  exports: [FileService, FileAnalyzerService, FileToolsService],
})
export class FileModule {}
