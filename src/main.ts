import * as dotenv from 'dotenv';
import * as path from 'path';
// Resolve .env relative to this file so the server works regardless of CWD
// (e.g. started from the repo root vs the backend/ directory)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Capture raw body for webhook signature verification, then parse as JSON.
  // Must be registered before any other body-consuming middleware.
  app.use(
    json({
      limit: '10mb',
      verify: (req: any, _res: any, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  const allowedOrigins = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const port = process.env.PORT || 8000;
  const isDev = process.env.NODE_ENV !== 'production';

  app.enableCors({
    origin: (origin, callback) => {
      // Allow server-to-server / SSR requests (no origin header) - testing this comment
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // In non-production allow any localhost/127.0.0.1 origin (the Next.js dev
      // server, Swagger UI, etc.) regardless of port so a port shift (3000→3001)
      // doesn't break local dev.
      if (isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
        return callback(null, true);
      callback(new Error(`CORS: origin ${origin} is not allowed`));
    },
    credentials: true,
  });

  app.setGlobalPrefix('api');

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // await app.listen(process.env.PORT ?? 8000);
  await app.listen(process.env.PORT || 8000, '0.0.0.0');
}
bootstrap();
