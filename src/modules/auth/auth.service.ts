import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { UserDocument, UserStatus } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { FirebaseVerifierService } from './services/firebase-verifier.service';
import { GoogleVerifierService } from './services/google-verifier.service';
import { OtpService } from './services/otp.service';
import { TokenPair, TokenService } from './services/token.service';

interface AuthContext {
  userAgent?: string;
  ipAddress?: string;
}

interface AuthResult {
  user: UserDocument;
  tokens: TokenPair;
  isNewUser?: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly googleVerifier: GoogleVerifierService,
    private readonly firebaseVerifier: FirebaseVerifierService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Sign in with a Google account.
   *
   * The mobile app uses Firebase Auth + GoogleSignIn — so the token we receive
   * here is a *Firebase* ID token (not a raw Google ID token). We try Firebase
   * verification first; if Firebase isn't configured, we fall back to
   * verifying the token as a raw Google ID token (legacy path).
   */
  async loginWithGoogle(params: {
    idToken: string;
    context?: AuthContext;
  }): Promise<AuthResult> {
    let email: string;
    let externalId: string;
    let name = '';
    let picture = '';

    if (this.firebaseVerifier.isReady()) {
      const decoded = await this.firebaseVerifier.verify(params.idToken);
      email = decoded.email!;
      externalId = decoded.uid;
      name = (decoded.name as string | undefined) ?? '';
      picture = (decoded.picture as string | undefined) ?? '';
    } else {
      const payload = await this.googleVerifier.verify(params.idToken);
      email = payload.email!;
      externalId = payload.sub;
      name = payload.name ?? '';
      picture = payload.picture ?? '';
    }

    let user = await this.users.findByGoogleIdOrEmail(externalId, email);
    let isNewUser = false;

    if (!user) {
      user = await this.users.createWithGoogle({
        email,
        googleId: externalId,
        displayName: name,
        avatarUrl: picture,
      });
      isNewUser = true;
    } else if (!user.googleId) {
      await this.users.linkGoogle(user._id.toString(), externalId);
      user = (await this.users.findById(user._id.toString()))!;
    }

    this.assertActive(user);

    const tokens = await this.tokens.issueTokenPair(
      {
        sub: user._id.toString(),
        email: user.email,
        username: user.username,
      },
      params.context,
    );

    await this.users.markLogin(user._id.toString());
    return { user, tokens, isNewUser };
  }

  async registerEmail(params: {
    email: string;
    password: string;
    username?: string;
    displayName?: string;
    context?: AuthContext;
  }): Promise<AuthResult> {
    if (await this.users.isEmailTaken(params.email)) {
      throw new ConflictException({ code: 'EMAIL_TAKEN', message: 'Email already registered' });
    }
    if (params.username && (await this.users.isUsernameTaken(params.username))) {
      throw new ConflictException({ code: 'USERNAME_TAKEN', message: 'Username already taken' });
    }

    const rounds = this.config.get<number>('security.bcryptRounds', 12);
    const passwordHash = await bcrypt.hash(params.password, rounds);

    const user = await this.users.createWithEmail({
      email: params.email,
      passwordHash,
      username: params.username,
      displayName: params.displayName,
    });

    const tokens = await this.tokens.issueTokenPair(
      {
        sub: user._id.toString(),
        email: user.email,
        username: user.username,
      },
      params.context,
    );

    await this.users.markLogin(user._id.toString());
    return { user, tokens };
  }

  async loginEmail(params: { email: string; password: string; context?: AuthContext }): Promise<AuthResult> {
    const user = await this.users.findByEmail(params.email, true);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    this.assertActive(user);

    const matches = await bcrypt.compare(params.password, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    const tokens = await this.tokens.issueTokenPair(
      {
        sub: user._id.toString(),
        email: user.email,
        username: user.username,
      },
      params.context,
    );

    await this.users.markLogin(user._id.toString());
    return { user, tokens };
  }

  async sendPhoneOtp(phone: string): Promise<{ cooldownSeconds: number }> {
    return this.otp.send(phone);
  }

  async verifyPhoneOtp(params: {
    phone: string;
    otp: string;
    username?: string;
    context?: AuthContext;
  }): Promise<AuthResult> {
    await this.otp.verify(params.phone, params.otp);

    let user = await this.users.findByPhone(params.phone);
    let isNewUser = false;

    if (!user) {
      if (params.username && (await this.users.isUsernameTaken(params.username))) {
        throw new ConflictException({ code: 'USERNAME_TAKEN', message: 'Username already taken' });
      }
      user = await this.users.createWithPhone({
        phone: params.phone,
        username: params.username,
      });
      isNewUser = true;
    }

    this.assertActive(user);

    const tokens = await this.tokens.issueTokenPair(
      {
        sub: user._id.toString(),
        phone: user.phone,
        username: user.username,
      },
      params.context,
    );

    await this.users.markLogin(user._id.toString());
    return { user, tokens, isNewUser };
  }

  /**
   * Report whether the caller has an email-login password set, plus
   * the email it would log in with. Drives the app settings UI so it
   * can show "Set password" (first time) vs "Change password".
   */
  async getPasswordStatus(
    userId: string,
  ): Promise<{ hasPassword: boolean; email: string | null }> {
    const user = await this.users.findByIdWithPassword(userId);
    if (!user) {
      throw new UnauthorizedException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    return {
      hasPassword: Boolean(user.passwordHash),
      email: user.email ?? null,
    };
  }

  /**
   * Set or change the caller's email-login password.
   *
   * - First-time set (Google / phone account with no password): the
   *   JWT on the request is proof of identity, so `currentPassword`
   *   is not required. The account MUST already have an email, since
   *   email + password is what login/email checks — without one the
   *   new password would be unusable.
   * - Change (account already has a password): `currentPassword` is
   *   required and must match.
   *
   * After this succeeds the user can sign in with email + password
   * anywhere that hits POST /auth/login/email — the mobile app's
   * email login AND the games web lobby — with no further changes,
   * because login/email already authenticates any user that has a
   * matching email + passwordHash.
   */
  async setPassword(params: {
    userId: string;
    newPassword: string;
    currentPassword?: string;
  }): Promise<{ hasPassword: true; email: string }> {
    const user = await this.users.findByIdWithPassword(params.userId);
    if (!user) {
      throw new UnauthorizedException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    this.assertActive(user);

    if (!user.email) {
      // No email on the account → email+password login can't work.
      // (Phone-only signups land here; they'd need to add an email
      // first, which is a separate flow.)
      throw new BadRequestException({
        code: 'NO_EMAIL_ON_ACCOUNT',
        message:
          'Your account has no email address, so an email password can’t be set.',
      });
    }

    if (user.passwordHash) {
      // Change flow — must prove knowledge of the current password.
      if (!params.currentPassword) {
        throw new BadRequestException({
          code: 'CURRENT_PASSWORD_REQUIRED',
          message: 'Enter your current password to change it.',
        });
      }
      const matches = await bcrypt.compare(
        params.currentPassword,
        user.passwordHash,
      );
      if (!matches) {
        throw new UnauthorizedException({
          code: 'INVALID_CURRENT_PASSWORD',
          message: 'Current password is incorrect.',
        });
      }
    }

    const rounds = this.config.get<number>('security.bcryptRounds', 12);
    const passwordHash = await bcrypt.hash(params.newPassword, rounds);
    await this.users.setPasswordHash(user._id.toString(), passwordHash);

    return { hasPassword: true, email: user.email };
  }

  async refresh(refreshToken: string, context?: AuthContext): Promise<TokenPair> {
    return this.tokens.rotate(refreshToken, context);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }

  private assertActive(user: UserDocument) {
    if (user.status === UserStatus.BANNED) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_BANNED',
        message: 'This account has been banned',
      });
    }
    if (user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account is temporarily suspended',
      });
    }
    if (user.status === UserStatus.DELETED) {
      throw new BadRequestException({
        code: 'ACCOUNT_DELETED',
        message: 'This account has been deleted',
      });
    }
  }
}
