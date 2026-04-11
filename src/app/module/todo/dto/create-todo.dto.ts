import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateTodoDto {
  @ApiPropertyOptional({ example: '' })
  @IsString()
  @IsNotEmpty({ message: 'Title is required' })
  title: string;

  @ApiPropertyOptional({ example: '' })
  @IsString()
  @IsNotEmpty({ message: 'Description is required' })
  description: string;

  @ApiPropertyOptional({ enum: [true, false], default: true })
  @IsBoolean()
  @IsNotEmpty({ message: 'isComplete is required' })
  isComplete: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  deadline?: Date;
}
