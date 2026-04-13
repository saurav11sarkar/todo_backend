import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { CreateAuthDto } from './dto/create-auth.dto';
import { Response } from 'express';
import * as bcrypt from 'bcrypt';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import config from '../../config';
import { PrismaService } from 'src/prisma/prisma.service';
import sendMailer from 'src/app/helper/sendMailer';
import { REDIS_CLIENT } from 'src/redis/redis.module';
import type { RedisClientType } from 'redis';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly TTL = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType,
  ) {}

  // ✅ Centralized keys
  private cacheKeys = {
    user: (id: string) => `user:${id}`,
    pattern: () => `user:*`,
  };

  // ✅ Safe cache setter
  private async setCache(key: string, value: any): Promise<void> {
    try {
      await this.redis.setEx(key, this.TTL, JSON.stringify(value));
    } catch (err) {
      this.logger.error('Cache SET error', err);
    }
  }

  // ✅ Safe cache getter
  private async getCache<T = any>(key: string): Promise<T | null> {
    try {
      const cached = await this.redis.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (err) {
      this.logger.error('Cache GET error', err);
      return null;
    }
  }

  // ✅ SCAN instead of KEYS
  private async invalidateAllUserCache(): Promise<void> {
    try {
      let cursor = '0';

      do {
        const res = await this.redis.scan(cursor, {
          MATCH: this.cacheKeys.pattern(),
          COUNT: 100,
        });

        cursor = res.cursor;

        if (res.keys.length) {
          await this.redis.del(res.keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      this.logger.error('Cache invalidation error', err);
    }
  }

  // ✅ Get user with cache
  private async getUserByEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) throw new HttpException('User not found', 404);

    return user;
  }

  async register(createAuthDto: CreateAuthDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: createAuthDto.email },
    });

    if (existing) throw new HttpException('User already exists', 400);

    const hashedPassword = await bcrypt.hash(createAuthDto.password, 10);

    const newUser = await this.prisma.user.create({
      data: {
        ...createAuthDto,
        password: hashedPassword,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    await this.invalidateAllUserCache();

    return newUser;
  }

  async login(loginDto: { email: string; password: string }, res: Response) {
    const user = await this.getUserByEmail(loginDto.email);

    const isPasswordMatch = await bcrypt.compare(
      loginDto.password,
      user.password,
    );

    if (!isPasswordMatch) {
      throw new HttpException('Incorrect password', 401);
    }

    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: config.jwt.accessTokenSecret,
      expiresIn: config.jwt.accessTokenExpires,
    } as JwtSignOptions);

    const refreshToken = this.jwtService.sign(payload, {
      secret: config.jwt.refreshTokenSecret,
      expiresIn: config.jwt.refreshTokenExpires,
    } as JwtSignOptions);

    // ✅ secure cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const { password: _, otp: __, otpExpires: ___, ...safeUser } = user;

    // ✅ cache user
    await this.setCache(this.cacheKeys.user(user.id), safeUser);

    return { accessToken, user: safeUser };
  }

  async forgotPassword(email: string) {
    const user = await this.getUserByEmail(email);

    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpires = new Date(Date.now() + 60 * 60 * 1000);

    await this.prisma.user.update({
      where: { email },
      data: { otp, otpExpires },
    });

    const html = `
      <div style="font-family: Arial; text-align: center;">
        <h2 style="color:#4f46e5;">Password Reset OTP</h2>
        <p>Your OTP code is:</p>
        <h1>${otp}</h1>
        <p>Expires in 1 hour</p>
      </div>
    `;

    await sendMailer(email, 'Reset Password OTP', html);

    return { message: 'Check your email for OTP' };
  }

  async verifyEmail(email: string, otp: string) {
    const user = await this.getUserByEmail(email);

    if (String(user.otp) !== otp) {
      throw new HttpException('Invalid OTP', 400);
    }

    if (!user.otpExpires || user.otpExpires < new Date()) {
      throw new HttpException('OTP expired', 400);
    }

    await this.prisma.user.update({
      where: { email },
      data: {
        otp: 0,
        otpExpires: null,
        verifiedForget: true,
      },
    });

    return { message: 'OTP verified successfully' };
  }

  async resetPasswordChange(email: string, newPassword: string) {
    const user = await this.getUserByEmail(email);

    if (!user.verifiedForget) {
      throw new HttpException('OTP not verified', 400);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({
      where: { email },
      data: {
        password: hashedPassword,
        verifiedForget: false,
      },
    });

    await this.invalidateAllUserCache();

    return { message: 'Password reset successfully' };
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) throw new HttpException('User not found', 404);

    const isMatch = await bcrypt.compare(oldPassword, user.password);

    if (!isMatch) {
      throw new HttpException('Invalid old password', 400);
    }

    if (oldPassword === newPassword) {
      throw new HttpException('New password cannot be same as old', 400);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    await this.invalidateAllUserCache();

    return { message: 'Password changed successfully' };
  }
}
