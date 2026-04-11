import { HttpException, Injectable } from '@nestjs/common';
import { CreateAuthDto } from './dto/create-auth.dto';
import { Response } from 'express';
import * as bcrypt from 'bcrypt';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import config from '../../config';
import { PrismaService } from 'src/prisma/prisma.service';
import sendMailer from 'src/app/helper/sendMailer';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

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
    return newUser;
  }

  async login(loginDto: { email: string; password: string }, res: Response) {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
    });
    if (!user) throw new HttpException('User not found', 404);

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
    });

    const { password: _, otp: __, otpExpires: ___, ...safeUser } = user;
    return { accessToken, user: safeUser };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new HttpException('Email not found', 404);

    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.user.update({
      where: { email },
      data: { otp, otpExpires },
    });

    const html = `
      <div style="font-family: Arial; text-align: center;">
        <h2 style="color:#4f46e5;">Password Reset OTP</h2>
        <p>Your OTP code is:</p>
        <h1 style="letter-spacing:4px;">${otp}</h1>
        <p>This code will expire in 1 hour.</p>
      </div>
    `;

    await sendMailer(email, 'Reset Password OTP', html);
    return { message: 'Check your email for OTP' };
  }

  async verifyEmail(email: string, otp: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new HttpException('Invalid request', 400);

    if (String(user.otp) !== otp) throw new HttpException('Invalid OTP', 400);
    if (!user.otpExpires) throw new HttpException('OTP not found', 400);
    if (user.otpExpires < new Date())
      throw new HttpException('OTP expired', 400);

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
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new HttpException('Invalid request', 400);
    if (!user.verifiedForget) throw new HttpException('OTP not verified', 400);

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({
      where: { email },
      data: { password: hashedPassword, verifiedForget: false },
    });

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

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return { message: 'Password changed successfully' };
  }
}
