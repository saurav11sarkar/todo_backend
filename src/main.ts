import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import dotenv from 'dotenv';
import { UtilsInterceptor } from './app/utils/utils.interceptor';
import express from 'express';
import { GlobalExceptionFilter } from './app/helper/globalerror.filter';
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  // app.use('/api/v1/webhook', express.raw({ type: 'application/json' }));

  app.use(cookieParser());
  app.enableCors({
    origin: '*',
    credentials: true,
  });

  app.setGlobalPrefix('api/v1', {
    exclude: [''],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new UtilsInterceptor());
  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new GlobalExceptionFilter(httpAdapterHost));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('App name API')
    .setDescription('App API Documentation')
    .setVersion('1.0')
    .addTag('App')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: 'Enter your JWT token',
        in: 'header',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(process.env.PORT ?? 3000, () => {
    console.log(
      `Server is running on http://localhost:${process.env.PORT ?? 3000}`,
    );
    console.log(
      `Swagger: http://localhost:${process.env.PORT ?? 3000}/api/docs`,
    );
  });
}
bootstrap().catch(console.error);
