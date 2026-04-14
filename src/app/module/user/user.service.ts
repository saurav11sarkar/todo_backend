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
import { CacheService } from 'src/redis/cache.service';

/**
 * UserService
 * -----------
 * Caching strategy:
 *  - getUserById/getMyProfile  → key `user:<id>`        tag `user:<id>`  (10 min)
 *  - getAllUser (paginated)    → key `users:list:p:l:q` tag `users:all`  (3 min)
 *  - createUser                → invalidate tag `users:all`
 *  - updateUser                → invalidate tags `user:<id>` + `users:all`
 *  - deleteUser                → invalidate tags `user:<id>` + `users:all`
 */
@Injectable()
export class UserService {
  private readonly USER_TTL = 600; // 10 min for single profile
  private readonly LIST_TTL = 180; // 3 min for paginated list

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

  private keys = {
    one: (id: string) => `user:${id}`,
    list: (page: number, limit: number, fingerprint: string) =>
      `users:list:p${page}:l${limit}:${fingerprint}`,
  };

  private tags = {
    user: (id: string) => `user:${id}`,
    allUsers: 'users:all',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ✅ CREATE USER
  async createUser(createUserDto: CreateUserDto, file?: Express.Multer.File) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: createUserDto.email },
    });
    if (existingUser) {
      throw new HttpException('User already exists', HttpStatus.BAD_REQUEST);
    }

    const hashedPassword = await bcrypt.hash(
      createUserDto.password,
      Number(config.bcryptSaltRounds) || 10,
    );

    if (file) {
      const image = await fileUpload.uploadToCloudinary(file);
      createUserDto.profilePicture = image.url;
    }

    const result = await this.prisma.user.create({
      data: { ...createUserDto, password: hashedPassword },
      select: this.userSelect,
    });

    // New row → list pages are stale.
    await this.cache.invalidateTags([this.tags.allUsers]);
    return result;
  }

  // ✅ GET ALL USERS (cached + tagged)
  async getAllUser(params: IFilterParams, options: IOptions) {
    const { page, limit, skip, sortBy, sortOrder } = paginationHelper(options);
    const fingerprint = Buffer.from(
      JSON.stringify({ params, sortBy, sortOrder }),
    ).toString('base64url').slice(0, 24);

    return this.cache.wrap(
      this.keys.list(page, limit, fingerprint),
      async () => {
        const whereCondition = buildWhereConditions(params, ['name', 'email']);
        const [data, total] = await Promise.all([
          this.prisma.user.findMany({
            where: whereCondition,
            skip,
            take: limit,
            orderBy: { [sortBy]: sortOrder },
            select: this.userSelect,
          }),
          this.prisma.user.count({ where: whereCondition }),
        ]);
        return { data, meta: { total, page, limit } };
      },
      { ttl: this.LIST_TTL, tags: [this.tags.allUsers] },
    );
  }

  // ✅ GET USER BY ID (cached + tagged)
  async getUserById(id: string) {
    return this.cache.wrap(
      this.keys.one(id),
      async () => {
        const user = await this.prisma.user.findUnique({
          where: { id },
          select: this.userSelect,
        });
        if (!user) throw new HttpException('User not found', 404);
        return user;
      },
      { ttl: this.USER_TTL, tags: [this.tags.user(id)] },
    );
  }

  // ✅ UPDATE USER
  async updateUser(
    id: string,
    updateUserDto: UpdateUserDto,
    file?: Express.Multer.File,
  ) {
    await this.getUserById(id); // reuses cache for existence check

    if (file) {
      const image = await fileUpload.uploadToCloudinary(file);
      updateUserDto.profilePicture = image.url;
    }

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

    await this.cache.invalidateTags([this.tags.user(id), this.tags.allUsers]);
    return result;
  }

  // ✅ DELETE USER
  async deleteUser(id: string) {
    await this.getUserById(id);
    const result = await this.prisma.user.delete({ where: { id } });
    await this.cache.invalidateTags([this.tags.user(id), this.tags.allUsers]);
    return result;
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
