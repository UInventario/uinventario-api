import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { CustomerController } from './customer.controller';
import { CustomerRepository } from './customer.repository';
import { CustomerService } from './customer.service';

@Module({
  imports: [SessionModule],
  controllers: [CustomerController],
  providers: [CustomerRepository, CustomerService, PermissionGuard],
  exports: [CustomerRepository],
})
export class CustomerModule {}
