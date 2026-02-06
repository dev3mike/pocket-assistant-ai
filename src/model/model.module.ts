import { Global, Module } from '@nestjs/common';
import { ModelFactoryService } from './model-factory.service';
import { AppConfigModule } from '../config/config.module';

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [ModelFactoryService],
  exports: [ModelFactoryService],
})
export class ModelModule {}
