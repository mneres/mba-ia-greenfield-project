export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class UploadTooLargeException extends DomainException {
  constructor(maxBytes: number) {
    super(
      'UPLOAD_TOO_LARGE',
      413,
      `Declared upload size exceeds the maximum of ${maxBytes} bytes`,
    );
  }
}

export class UploadQuotaExceededException extends DomainException {
  constructor(reason: string) {
    super('UPLOAD_QUOTA_EXCEEDED', 409, reason);
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    // Mesma resposta para "não existe" e para "existe mas não está pronto e
    // você não é o dono": distinguir os dois tornaria vídeos não-publicados
    // enumeráveis (per `phase-03-videos/TD-15`).
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}
