import { Module } from '@nestjs/common';
import { TodoService } from './todo.service';
import { TodoController } from './todo.controller';
import { TodoScheduler } from 'src/app/helper/todo.scheduler';
import { WhatsappOrSmsService } from 'src/app/helper/whatappOrSms';

@Module({
  controllers: [TodoController],
  providers: [TodoService, TodoScheduler, WhatsappOrSmsService],
  exports: [TodoService],
})
export class TodoModule {}
