import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { argon2id, hash, verify } from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { sessionConfig } from '../../config/session.config';
import { CreateSessionDto } from './dto/create-session.dto';
import { SessionRepository } from './session.repository';
import { SessionIdentity, SessionResponse } from './session.types';

const ARGON_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class SessionService {
  private readonly dummyHash = hash(
    'not-a-real-uinventario-password',
    ARGON_OPTIONS,
  );

  constructor(
    private readonly sessions: SessionRepository,
    @Inject(sessionConfig.KEY)
    private readonly config: ConfigType<typeof sessionConfig>,
  ) {}

  async login(dto: CreateSessionDto): Promise<{
    token: string;
    expiresAt: Date;
    response: SessionResponse;
  }> {
    const identity = await this.sessions.findLoginIdentity(dto.email);
    const passwordMatches = await verify(
      identity?.passwordHash ?? (await this.dummyHash),
      dto.password,
    );

    if (!identity || !passwordMatches) {
      throw this.invalidCredentials();
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.ttlMilliseconds);
    await this.sessions.createSession({
      tokenHash: this.hashToken(token),
      userId: identity.user.id,
      tenantId: identity.tenant.id,
      expiresAt,
    });

    return {
      token,
      expiresAt,
      response: this.toResponse(identity, expiresAt),
    };
  }

  async authenticate(token: string | undefined): Promise<SessionIdentity> {
    if (!token) {
      throw this.invalidSession();
    }

    const identity = await this.sessions.findActiveSession(
      this.hashToken(token),
      new Date(),
    );
    if (!identity) {
      throw this.invalidSession();
    }
    return identity;
  }

  async refresh(
    principal: SessionIdentity,
    currentToken: string,
  ): Promise<{ token: string; expiresAt: Date; response: SessionResponse }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.ttlMilliseconds);
    const rotated = await this.sessions.rotateSession(
      principal.sessionId,
      this.hashToken(currentToken),
      this.hashToken(token),
      expiresAt,
      new Date(),
    );

    if (!rotated) {
      throw this.invalidSession();
    }

    return {
      token,
      expiresAt,
      response: this.toResponse(principal, expiresAt),
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revokeSession(sessionId, new Date());
  }

  toResponse(
    identity: Omit<SessionIdentity, 'sessionId' | 'expiresAt'>,
    expiresAt: Date,
  ): SessionResponse {
    return {
      data: {
        user: identity.user,
        tenant: identity.tenant,
        nextStep: identity.nextStep,
      },
      meta: {
        apiVersion: '1',
        sessionExpiresAt: expiresAt.toISOString(),
      },
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'INVALID_CREDENTIALS',
      message: 'Las credenciales no son válidas.',
    });
  }

  private invalidSession(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'INVALID_SESSION',
      message: 'La sesión no es válida.',
    });
  }
}
