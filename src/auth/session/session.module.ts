import { Module } from '@nestjs/common';
import { SessionController } from './session.controller';
import { SessionGuard } from './session.guard';
import { SessionRepository } from './session.repository';
import { SessionService } from './session.service';

@Module({
  controllers: [SessionController],
  providers: [SessionGuard, SessionRepository, SessionService],
  exports: [SessionGuard, SessionService],
})
export class SessionModule {}
