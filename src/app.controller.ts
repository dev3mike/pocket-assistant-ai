/**
 * HTTP root endpoint (GET /). Returns a simple "bot is running" message; the real
 * app is the Telegram bot and agents, not this controller.
 */
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get()
  async getHello(): Promise<string> {
    return await this.appService.getHello();
  }
}
