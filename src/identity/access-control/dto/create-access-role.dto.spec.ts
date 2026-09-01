import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAccessRoleDto } from './create-access-role.dto';

describe('CreateAccessRoleDto', () => {
  it('allows product management in an operational role', async () => {
    const dto = plainToInstance(CreateAccessRoleDto, {
      name: 'Catalogador',
      permissions: ['PRODUCTS_MANAGE'],
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('does not delegate tenant or access administration through custom roles', async () => {
    const dto = plainToInstance(CreateAccessRoleDto, {
      name: 'Administrador falso',
      permissions: ['TENANT_MANAGE', 'ACCESS_MANAGE'],
    });

    await expect(validate(dto)).resolves.not.toEqual([]);
  });
});
