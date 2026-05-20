import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Set or change the caller's email-login password.
 *
 * Used by Google / phone users who want a password so they can ALSO
 * sign in with email + password (in the app and the games web lobby),
 * and by existing email users changing their password.
 *
 * `currentPassword` is required ONLY when the account already has a
 * password (a change). First-time set (a Google-only account) omits
 * it — the JWT on the request is the proof of identity. The service
 * enforces this conditionally; it can't be expressed in the DTO.
 */
export class SetPasswordDto {
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(72, { message: 'Password must be at most 72 characters' })
  @Matches(/(?=.*[a-zA-Z])(?=.*\d)/, {
    message: 'Password must contain at least one letter and one number',
  })
  newPassword!: string;

  @IsOptional()
  @IsString()
  @MaxLength(72)
  currentPassword?: string;
}
