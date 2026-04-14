import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { IFilterParams } from 'src/app/helper/pick';
import paginationHelper, { IOptions } from 'src/app/helper/pagenation';
import buildWhereConditions from 'src/app/helper/buildWhereConditions';
import { WhatsappOrSmsService } from 'src/app/helper/whatappOrSms';
import { CacheService } from 'src/redis/cache.service';

/**
 * TodoService
 * -----------
 * Caching switched from wildcard SCAN-on-write to **tag-based invalidation**:
 *
 *   wrap(`todo:${userId}:${id}`,  ..., { tags: [`user:${userId}`, `todo:${id}`] })
 *   wrap(`todos:${userId}:p:l:f`, ..., { tags: [`user:${userId}`, `todos:${userId}`] })
 *
 *   on write → invalidateTags([`todos:${userId}`, `todo:${id}`])
 *
 * No more `KEYS pattern` in production; no more SCAN sweep on every mutation.
 * Tag-based delete is O(N members) with a single Redis SET lookup.
 */
@Injectable()
export class TodoService {
  private readonly logger = new Logger(TodoService.name);
  private readonly TTL = 300;

  private keys = {
    one: (userId: string, id: string) => `todo:${userId}:${id}`,
    list: (userId: string, page: number, limit: number, fp: string) =>
      `todos:${userId}:p${page}:l${limit}:${fp}`,
  };

  private tags = {
    todo: (id: string) => `todo:${id}`,
    userTodos: (userId: string) => `todos:${userId}`,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsappOrSms: WhatsappOrSmsService,
    private readonly cache: CacheService,
  ) {}

  async getUser(userId: string) {
    return this.prisma.user.findUnique({ where: { id: userId } });
  }

  async createTodo(userId: string, dto: CreateTodoDto) {
    const result = await this.prisma.todo.create({
      data: {
        title: dto.title,
        description: dto.description,
        isComplete: dto.isComplete ?? false,
        deadline: dto.deadline ? new Date(dto.deadline) : null,
        userId,
      },
    });

    if (!result)
      throw new HttpException('Todo not created', HttpStatus.BAD_REQUEST);

    // New todo → all paginated lists for this user are stale.
    await this.cache.invalidateTags([this.tags.userTodos(userId)]);
    return result;
  }

  async findAll(userId: string, params: IFilterParams, options: IOptions) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpException('User is not found', 404);

    const { limit, page, skip, sortBy, sortOrder } = paginationHelper(options);
    // Fingerprint of filters → unique cache key per filter combo
    const fp = Buffer.from(
      JSON.stringify({ params, sortBy, sortOrder }),
    )
      .toString('base64url')
      .slice(0, 20);

    return this.cache.wrap(
      this.keys.list(userId, page, limit, fp),
      async () => {
        const whenCondition = buildWhereConditions(
          params,
          ['title', 'description'],
          { userId },
        );
        const [result, total] = await Promise.all([
          this.prisma.todo.findMany({
            where: whenCondition,
            orderBy: { [sortBy]: sortOrder },
            skip,
            take: limit,
          }),
          this.prisma.todo.count({ where: whenCondition }),
        ]);
        return { data: result, meta: { total, page, limit } };
      },
      { ttl: this.TTL, tags: [this.tags.userTodos(userId)] },
    );
  }

  async findOne(userId: string, id: string) {
    return this.cache.wrap(
      this.keys.one(userId, id),
      async () => {
        const result = await this.prisma.todo.findFirst({
          where: { id, userId },
        });
        if (!result)
          throw new HttpException('Todo not found', HttpStatus.NOT_FOUND);
        return result;
      },
      { ttl: this.TTL, tags: [this.tags.todo(id), this.tags.userTodos(userId)] },
    );
  }

  async updateTodo(userId: string, id: string, dto: UpdateTodoDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpException('User is not found', 404);

    const existing = await this.findOne(userId, id);
    const isNowCompleting = dto.isComplete === true && !existing.isComplete;

    const completedAt = isNowCompleting
      ? new Date()
      : dto.isComplete === false
        ? null
        : existing.completedAt;

    const deadlineChanged =
      dto?.deadline !== undefined &&
      (dto?.deadline as any) !== existing.deadline?.toISOString();

    const result = await this.prisma.todo.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.isComplete !== undefined && { isComplete: dto.isComplete }),
        ...(dto.deadline !== undefined && { deadline: new Date(dto.deadline) }),
        completedAt,
        ...(deadlineChanged && {
          whatsappNotified: false,
          reminderSent: false,
        }),
      },
    });

    if (!result)
      throw new HttpException('Todo not updated', HttpStatus.BAD_REQUEST);

    if (
      isNowCompleting &&
      user.whatsappNumber &&
      this.whatsappOrSms.isEnabled()
    ) {
      const msg = this.whatsappOrSms.completedMessage(result.title);
      await this.whatsappOrSms.sendMessage(user.whatsappNumber, msg);
      this.logger.log(`✅ Completion message sent for: "${result.title}"`);
    }

    await this.cache.invalidateTags([
      this.tags.todo(id),
      this.tags.userTodos(userId),
    ]);
    return result;
  }

  async removeTodo(userId: string, id: string) {
    await this.findOne(userId, id);
    const result = await this.prisma.todo.delete({ where: { id } });
    if (!result)
      throw new HttpException('Todo not deleted', HttpStatus.BAD_REQUEST);

    await this.cache.invalidateTags([
      this.tags.todo(id),
      this.tags.userTodos(userId),
    ]);
    return result;
  }

  async findOverdueTodos() {
    const now = new Date();
    return this.prisma.todo.findMany({
      where: {
        isComplete: false,
        whatsappNotified: false,
        deadline: { lt: now },
      },
      include: { user: true },
    });
  }

  async findUpcomingTodos(minutesAhead: number) {
    const now = new Date();
    const future = new Date(now.getTime() + minutesAhead * 60 * 1000);
    const buffer = new Date(now.getTime() + (minutesAhead - 1) * 60 * 1000);

    return this.prisma.todo.findMany({
      where: {
        isComplete: false,
        reminderSent: false,
        deadline: { gte: buffer, lte: future },
      },
      include: { user: true },
    });
  }

  async markNotified(id: string) {
    return this.prisma.todo.update({
      where: { id },
      data: { whatsappNotified: true },
    });
  }

  async markReminderSent(id: string) {
    return this.prisma.todo.update({
      where: { id },
      data: { reminderSent: true },
    });
  }

  async resetNotifications(userId: string): Promise<number> {
    const result = await this.prisma.todo.updateMany({
      where: {
        userId,
        isComplete: false,
        deadline: { lt: new Date() },
        whatsappNotified: true,
      },
      data: {
        whatsappNotified: false,
        reminderSent: false,
      },
    });
    return result.count;
  }
}
