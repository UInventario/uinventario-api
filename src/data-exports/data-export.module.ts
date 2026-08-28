import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SessionModule } from '../auth/session/session.module';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';

@Module({
  imports: [SessionModule, AuditModule],
  controllers: [DataExportController],
  providers: [DataExportService],
})
export class DataExportModule {}
