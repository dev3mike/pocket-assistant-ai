import { Module, Global } from '@nestjs/common';
import { NotepadService } from './notepad.service';

@Global()
@Module({
  providers: [NotepadService],
  exports: [NotepadService],
})
export class NotepadModule {}
