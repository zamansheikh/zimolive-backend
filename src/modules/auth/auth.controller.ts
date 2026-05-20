import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { SocialService } from '../social/social.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import { LoginEmailDto } from './dto/login-email.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterEmailDto } from './dto/register-email.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { SetPasswordDto } from './dto/set-password.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly social: SocialService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register/email')
  async registerEmail(@Body() dto: RegisterEmailDto, @Req() req: Request) {
    const result = await this.auth.registerEmail({
      ...dto,
      context: { userAgent: req.headers['user-agent'], ipAddress: req.ip },
    });
    return this.shape(result);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login/email')
  async loginEmail(@Body() dto: LoginEmailDto, @Req() req: Request) {
    const result = await this.auth.loginEmail({
      ...dto,
      context: { userAgent: req.headers['user-agent'], ipAddress: req.ip },
    });
    return this.shape(result);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('otp/send')
  async sendOtp(@Body() dto: SendOtpDto) {
    const r = await this.auth.sendPhoneOtp(dto.phone);
    return { sent: true, cooldownSeconds: r.cooldownSeconds };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login/google')
  async loginGoogle(@Body() dto: GoogleLoginDto, @Req() req: Request) {
    const result = await this.auth.loginWithGoogle({
      idToken: dto.idToken,
      context: { userAgent: req.headers['user-agent'], ipAddress: req.ip },
    });
    return { ...this.shape(result), isNewUser: result.isNewUser };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('otp/verify')
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    const result = await this.auth.verifyPhoneOtp({
      phone: dto.phone,
      otp: dto.otp,
      username: dto.username,
      context: { userAgent: req.headers['user-agent'], ipAddress: req.ip },
    });
    return { ...this.shape(result), isNewUser: result.isNewUser };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    const tokens = await this.auth.refresh(dto.refreshToken, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    return { tokens };
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Body() dto: RefreshTokenDto) {
    await this.auth.logout(dto.refreshToken);
    return { success: true };
  }

  /**
   * Whether the caller has an email-login password set (+ the email
   * it'd use). The app settings screen reads this to label the row
   * "Set password" vs "Change password".
   */
  @Get('password-status')
  async passwordStatus(@CurrentUser() current: AuthenticatedUser) {
    return this.auth.getPasswordStatus(current.userId);
  }

  /**
   * Set or change the caller's email-login password. Lets a Google /
   * phone user create an email + password credential so they can ALSO
   * log in with email + password — in the app and the games web lobby.
   * `currentPassword` is required only when changing an existing one.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('set-password')
  async setPassword(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: SetPasswordDto,
  ) {
    return this.auth.setPassword({
      userId: current.userId,
      newPassword: dto.newPassword,
      currentPassword: dto.currentPassword,
    });
  }

  @Get('me')
  async me(@CurrentUser() current: AuthenticatedUser) {
    const user = await this.users.getByIdOrThrow(current.userId);
    // Mobile's AuthBloc refreshes through this endpoint on app boot
    // and pull-to-refresh, so it has to carry the same enrichment the
    // /users/me endpoint does — otherwise the Me tab's stat strip
    // gets stuck at 0 for visitors / friends. followersCount /
    // followingCount come for free off the denormalized fields on the
    // user doc.
    const [visitorsCount, friendsCount] = await Promise.all([
      this.social.visitorsCount(current.userId),
      this.social.friendsCount(current.userId),
    ]);
    const json = user.toJSON() as Record<string, unknown>;
    json.visitorsCount = visitorsCount;
    json.friendsCount = friendsCount;
    return { user: json };
  }

  private shape(result: { user: unknown; tokens: unknown }) {
    return { user: result.user, tokens: result.tokens };
  }
}
