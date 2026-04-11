import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import bcrypt from 'bcrypt';
import config from 'src/app/config';
import { IFilterParams } from 'src/app/helper/pick';
import paginationHelper, { IOptions } from 'src/app/helper/pagenation';
import buildWhereConditions from 'src/app/helper/buildWhereConditions';
import { fileUpload } from 'src/app/helper/fileUploder';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  // 🔐 Remove password globally
  private userSelect = {
    id: true,
    email: true,
    name: true,
    whatsappNumber: true,
    profilePicture: true,
    gender: true,
    status: true,
    country: true,
    city: true,
    address: true,
    dateOfBirth: true,
    role: true,
    createdAt: true,
    updatedAt: true,
  };

  // ✅ CREATE USER
  async createUser(createUserDto: CreateUserDto, file?: Express.Multer.File) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: createUserDto.email },
    });

    if (existingUser) {
      throw new HttpException('User already exists', HttpStatus.BAD_REQUEST);
    }

    // 🔐 hash password
    const hashedPassword = await bcrypt.hash(
      createUserDto.password,
      Number(config.bcryptSaltRounds) || 10,
    );

    // 🖼 upload image
    if (file) {
      const image = await fileUpload.uploadToCloudinary(file);
      createUserDto.profilePicture = image.url;
    }

    const result = await this.prisma.user.create({
      data: {
        ...createUserDto,
        password: hashedPassword,
      },
      select: this.userSelect,
    });

    return result;
  }

  // ✅ GET ALL USERS
  async getAllUser(params: IFilterParams, options: IOptions) {
    const { page, limit, skip, sortBy, sortOrder } = paginationHelper(options);

    const whereCondition = buildWhereConditions(params, ['name', 'email']);

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where: whereCondition,
        skip,
        take: limit,
        orderBy: {
          [sortBy]: sortOrder,
        },
        select: this.userSelect,
      }),
      this.prisma.user.count({
        where: whereCondition,
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
      },
    };
  }

  // ✅ GET USER BY ID
  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: this.userSelect,
    });

    if (!user) throw new HttpException('User not found', 404);

    return user;
  }

  // ✅ UPDATE USER
  async updateUser(
    id: string,
    updateUserDto: UpdateUserDto,
    file?: Express.Multer.File,
  ) {
    await this.getUserById(id);

    // 🖼 upload image
    if (file) {
      const image = await fileUpload.uploadToCloudinary(file);
      updateUserDto.profilePicture = image.url;
    }

    // 🔐 hash password if exists
    if (updateUserDto.password) {
      updateUserDto.password = await bcrypt.hash(
        updateUserDto.password,
        Number(config.bcryptSaltRounds) || 10,
      );
    }

    const result = await this.prisma.user.update({
      where: { id },
      data: updateUserDto,
      select: this.userSelect,
    });

    return result;
  }

  // ✅ DELETE USER
  async deleteUser(id: string) {
    await this.getUserById(id);

    return this.prisma.user.delete({
      where: { id },
    });
  }

  // ✅ MY PROFILE
  async getMyProfile(userId: string) {
    return this.getUserById(userId);
  }

  async updateMyProfile(
    userId: string,
    updateUserDto: UpdateUserDto,
    file?: Express.Multer.File,
  ) {
    return this.updateUser(userId, updateUserDto, file);
  }
}
