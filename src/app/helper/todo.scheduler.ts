import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TodoService } from '../module/todo/todo.service';
import { WhatsappOrSmsService } from './whatappOrSms';

@Injectable()
export class TodoScheduler {
  private readonly logger = new Logger(TodoScheduler.name);

  constructor(
    private readonly todoService: TodoService,
    private readonly whatsappOrSms: WhatsappOrSmsService,
  ) {}

  /**
   * Runs every minute.
   * Sends WhatsApp/SMS if a task's deadline has passed and not yet notified.
   * Flow: WhatsApp first → SMS fallback (handled by WhatsappOrSmsService)
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleOverdueTasks() {
    try {
      if (!this.whatsappOrSms.isEnabled()) return;

      const todos = await this.todoService.findOverdueTodos();
      if (!todos.length) return;

      this.logger.warn(`Found ${todos.length} overdue task(s)`);

      for (const todo of todos) {
        const phone = todo.user?.whatsappNumber;
        if (!phone) {
          this.logger.warn(`No phone for user of todo "${todo.title}"`);
          continue;
        }

        const msg = this.whatsappOrSms.overdueMessage(todo.title);
        const sent = await this.whatsappOrSms.sendMessage(phone, msg);

        if (sent) {
          await this.todoService.markNotified(todo.id);
          this.logger.log(`Overdue alert sent: "${todo.title}" -> ${phone}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`Error in handleOverdueTasks: ${error.message}`);
    }
  }

  /**
   * Runs every minute.
   * Sends a 30-minute warning before deadline.
   * Only sends once per task (tracked via reminderSent flag).
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleUpcomingReminders() {
    try {
      if (!this.whatsappOrSms.isEnabled()) return;

      const MINUTES_BEFORE = 30;
      const todos = await this.todoService.findUpcomingTodos(MINUTES_BEFORE);
      if (!todos.length) return;

      this.logger.log(`Found ${todos.length} upcoming task(s) in ~30 min`);

      for (const todo of todos) {
        const phone = todo.user?.whatsappNumber;
        if (!phone) continue;

        const msg = this.whatsappOrSms.reminderMessage(
          todo.title,
          MINUTES_BEFORE,
        );
        const sent = await this.whatsappOrSms.sendMessage(phone, msg);

        if (sent) {
          await this.todoService.markReminderSent(todo.id);
          this.logger.log(
            `30-min reminder sent: "${todo.title}" -> ${phone}`,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(
        `Error in handleUpcomingReminders: ${error.message}`,
      );
    }
  }
}
