import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  Req,
  Patch,
  UploadedFile,
  UseGuards,
  Put,
  UseInterceptors,
  Param,
  Delete,
} from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import pick from 'src/app/helper/pick';
import { AuthGuard } from 'src/app/middlewares/auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { fileUpload } from 'src/app/helper/fileUploder';

@ApiTags('user')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @ApiOperation({
    summary: 'create user',
  })
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Body() createUserDto: CreateUserDto) {
    const result = await this.userService.createUser(createUserDto);

    return {
      message: 'create user successfully',
      data: result,
    };
  }

  @Get()
  @ApiOperation({
    summary: 'get all user',
  })
  @ApiQuery({
    name: 'searchTerm',
    type: String,
    required: false,
    description: 'search term',
  })
  @ApiQuery({
    name: 'role',
    type: String,
    required: false,
    description: 'role',
  })
  @ApiQuery({
    name: 'email',
    type: String,
    required: false,
    description: 'email',
  })
  @ApiQuery({
    name: 'name',
    type: String,
    required: false,
    description: 'name',
  })
  @ApiQuery({
    name: 'page',
    type: Number,
    required: false,
    description: 'page number',
  })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'limit number',
  })
  @ApiQuery({
    name: 'sortBy',
    type: String,
    required: false,
    description: 'sort by',
  })
  @ApiQuery({
    name: 'sortOrder',
    type: String,
    required: false,
    description: 'sort order',
  })
  @UseGuards(AuthGuard('admin', 'user'))
  @HttpCode(HttpStatus.OK)
  async getAllUser(@Req() req: Request) {
    const filters = pick(req.query, ['searchTerm', 'role', 'email', 'name']);
    const options = pick(req.query, ['page', 'limit', 'sortBy', 'sortOrder']);
    const result = await this.userService.getAllUser(filters, options);

    return {
      message: 'get all user successfully',
      meta: result.meta,
      data: result.data,
    };
  }

  @Get('profile')
  @ApiOperation({
    summary: 'Get the profile of the currently authenticated user',
  })
  @ApiBearerAuth('access-token')
  @UseGuards(AuthGuard('admin', 'user'))
  @HttpCode(HttpStatus.OK)
  async getMyProfile(@Req() req: Request) {
    const user = await this.userService.getMyProfile(req.user!.id);
    return {
      message: 'User fetched successfully',
      data: user,
    };
  }

  @Put('profile')
  @ApiOperation({
    summary: 'Update the profile of the currently authenticated user',
  })
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @UseGuards(AuthGuard('admin', 'user'))
  @UseInterceptors(FileInterceptor('profilePicture', fileUpload.uploadConfig))
  @ApiBody({ type: UpdateUserDto })
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Req() req: Request,
    @Body() updateUserDto: UpdateUserDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const result = await this.userService.updateMyProfile(
      req.user!.id,
      updateUserDto,
      file,
    );
    return {
      message: 'User updated successfully',
      data: result,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get single user by id',
  })
  @ApiQuery({
    name: 'id',
    required: true,
    type: String,
    example: '',
    description: 'User id',
  })
  @HttpCode(HttpStatus.OK)
  async getUserById(@Param('id') id: string) {
    const result = await this.userService.getUserById(id);

    return {
      message: 'User fetched successfully',
      data: result,
    };
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update user by id',
  })
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @UseGuards(AuthGuard('admin'))
  @UseInterceptors(FileInterceptor('profilePicture', fileUpload.uploadConfig))
  @ApiBody({ type: UpdateUserDto })
  @HttpCode(HttpStatus.OK)
  async updateUser(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const result = await this.userService.updateUser(id, updateUserDto, file);

    return {
      message: 'User updated successfully',
      data: result,
    };
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete user by id',
  })
  @ApiBearerAuth('access-token')
  @UseGuards(AuthGuard('admin'))
  @ApiQuery({
    name: 'id',
    required: true,
    type: String,
    example: '',
    description: 'User id',
  })
  @HttpCode(HttpStatus.OK)
  async deleteUser(@Param('id') id: string) {
    const result = await this.userService.deleteUser(id);

    return {
      message: 'User deleted successfully',
      data: result,
    };
  }
}
