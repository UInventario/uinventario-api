import { BadRequestException } from '@nestjs/common';
import { AccessControlRepository } from './access-control.repository';
import { AccessControlService } from './access-control.service';
import { AccessRetirementConfirmationError } from './access-control.errors';

describe('AccessControlService', () => {
  it('maps an invalid contextual confirmation to a stable API error', async () => {
    const repository = {
      retireUser: jest
        .fn()
        .mockRejectedValue(new AccessRetirementConfirmationError()),
    } as unknown as AccessControlRepository;
    const service = new AccessControlService(repository);

    const request = service.retireUser(
      'tenant-1',
      'admin-1',
      'user-1',
      'wrong@example.com',
    );

    await expect(request).rejects.toBeInstanceOf(BadRequestException);
    await expect(request).rejects.toMatchObject({
      response: {
        code: 'ACCESS_RETIREMENT_CONFIRMATION_INVALID',
      },
    });
  });
});
