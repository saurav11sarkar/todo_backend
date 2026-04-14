import { HttpException, Injectable, Logger } from '@nestjs/common';
import { CreateAuthDto } from './dto/create-auth.dto';
import { Response } from 'express';
import * as bcrypt from 'bcrypt';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import config from '../../config';
import { PrismaService } from 'src/prisma/prisma.service';
import sendMailer from 'src/app/helper/sendMailer';
import { CacheService } from 'src/redis/cache.service';

/**
 * AuthService — Redis usage redesigned
 * ====================================
 * Old version reached into the raw Redis client and duplicated cache logic
 * (setEx, get, SCAN). Now everything goes through CacheService:
 *
 *  - User session cache    → tag `user:<id>` (cleared on update/delete/pwd-reset)
 *  - OTP storage           → cache.setEx (auto-expires, no DB column needed)
 *  - JWT blacklist         → cache.setEx until the token's natural expiry
 *  - Login rate limiting   → cache.incr with TTL
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // Centralized keys — easy to grep, easy to invalidate.
  private keys = {
    user: (id: string) => `user:${id}`,
    otp: (email: string) => `otp:${email}`,
    forgotVerified: (email: string) => `forgot:verified:${email}`,
    jwtBlacklist: (jti: string) => `jwt:bl:${jti}`,
    loginRate: (ip: string) => `ratelimit:login:${ip}`,
  };

  // Tags — group keys logically so we can invalidate by relationship.
  private tags = {
    user: (id: string) => `user:${id}`,
    allUsers: 'users:all',
  };

  private readonly OTP_TTL = 600; // 10 minutes
  private readonly FORGOT_VERIFIED_TTL = 600; // 10 minutes window
  private readonly LOGIN_RATE_TTL = 60; // 60 seconds
  private readonly LOGIN_RATE_MAX = 10; // 10 attempts / 60 sec / IP

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly cache: CacheService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────
  private async getUserByEmail(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new HttpException('User not found', 404);
    return user;
  }

  private stripSensitive<T extends { password?: any; otp?: any; otpExpires?: any }>(
    user: T,
  ) {
    const { password, otp, otpExpires, ...safe } = user;
    return safe;
  }

  // ─── Register ──────────────────────────────────────────────────────
  async register(createAuthDto: CreateAuthDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: createAuthDto.email },
    });
    if (existing) throw new HttpException('User already exists', 400);

    const hashedPassword = await bcrypt.hash(
      createAuthDto.password,
      Number(config.bcryptSaltRounds) || 10,
    );

    const newUser = await this.prisma.user.create({
      data: { ...createAuthDto, password: hashedPassword },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    // Only the listings cache is stale — single-user cache doesn't exist yet.
    await this.cache.invalidateTags([this.tags.allUsers]);
    return newUser;
  }

  // ─── Login (with rate limit + cached profile) ──────────────────────
  async login(
    loginDto: { email: string; password: string },
    res: Response,
    clientIp = 'unknown',
  ) {
    // Throttle brute-force per IP
    const attempts = await this.cache.incr(
      this.keys.loginRate(clientIp),
      this.LOGIN_RATE_TTL,
    );
    if (attempts > this.LOGIN_RATE_MAX) {
      throw new HttpException('Too many login attempts. Try again later.', 429);
    }

    const user = await this.getUserByEmail(loginDto.email);
    const isPasswordMatch = await bcrypt.compare(
      loginDto.password,
      user.password,
    );
    if (!isPasswordMatch) throw new HttpException('Incorrect password', 401);

    const payload = { id: user.id, email: user.email, role: user.role };

    const accessToken = this.jwtService.sign(payload, {
      secret: config.jwt.accessTokenSecret,
      expiresIn: config.jwt.accessTokenExpires,
    } as JwtSignOptions);

    const refreshToken = this.jwtService.sign(payload, {
      secret: config.jwt.refreshTokenSecret,
      expiresIn: config.jwt.refreshTokenExpires,
    } as JwtSignOptions);

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const safeUser = this.stripSensitive(user);

    // Cache profile under the user-tag so updates wipe it cleanly.
    await this.cache.set(this.keys.user(user.id), safeUser, 600);
    return { accessToken, user: safeUser };
  }

  // ─── Logout — blacklist the JWT until it would naturally expire ────
  async logout(jti: string, expiresInSec: number, res: Response) {
    if (jti && expiresInSec > 0) {
      await this.cache.setEx(this.keys.jwtBlacklist(jti), '1', expiresInSec);
    }
    res.clearCookie('refreshToken');
    return { message: 'Logged out' };
  }

  /** Used by JwtAuthGuard to reject revoked tokens. */
  async isJwtBlacklisted(jti: string): Promise<boolean> {
    return this.cache.exists(this.keys.jwtBlacklist(jti));
  }

  // ─── Forgot password (OTP in Redis, not in DB) ─────────────────────
  async forgotPassword(email: string) {
    const user = await this.getUserByEmail(email);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    // Store OTP in Redis with auto-expiry — no DB cleanup ever needed.
    await this.cache.setEx(this.keys.otp(user.email), otp, this.OTP_TTL);

    const html = `
      <div style="font-family: Arial; text-align: center;">
        <h2 style="color:#4f46e5;">Password Reset OTP</h2>
        <p>Your OTP code is:</p>
        <h1>${otp}</h1>
        <p>Expires in 10 minutes</p>
      </div>
    `;
    await sendMailer(email, 'Reset Password OTP', html);
    return { message: 'Check your email for OTP' };
  }

  async verifyEmail(email: string, otp: string) {
    const saved = await this.cache.get<string>(this.keys.otp(email));
    if (!saved) throw new HttpException('OTP expired or not requested', 400);
    if (saved !== otp) throw new HttpException('Invalid OTP', 400);

    // OTP consumed — delete it and mark this email as verified for a window.
    await this.cache.del(this.keys.otp(email));
    await this.cache.setEx(
      this.keys.forgotVerified(email),
      '1',
      this.FORGOT_VERIFIED_TTL,
    );
    return { message: 'OTP verified successfully' };
  }

  async resetPasswordChange(email: string, newPassword: string) {
    const verified = await this.cache.exists(this.keys.forgotVerified(email));
    if (!verified) throw new HttpException('OTP not verified', 400);

    const user = await this.getUserByEmail(email);
    const hashedPassword = await bcrypt.hash(
      newPassword,
      Number(config.bcryptSaltRounds) || 10,
    );

    await this.prisma.user.update({
      where: { email },
      data: { password: hashedPassword },
    });

    await this.cache.del(this.keys.forgotVerified(email));
    await this.cache.invalidateTags([this.tags.user(user.id)]);
    return { message: 'Password reset successfully' };
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpException('User not found', 404);

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) throw new HttpException('Invalid old password', 400);
    if (oldPassword === newPassword)
      throw new HttpException('New password cannot be same as old', 400);

    const hashedPassword = await bcrypt.hash(
      newPassword,
      Number(config.bcryptSaltRounds) || 10,
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    await this.cache.invalidateTags([this.tags.user(userId)]);
    return { message: 'Password changed successfully' };
  }
}
