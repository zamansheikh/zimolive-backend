import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { TraceIdInterceptor } from './common/interceptors/trace-id.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  const apiPrefix = config.get<string>('api.prefix', 'api');
  const apiVersion = config.get<string>('api.version', 'v1').replace(/^v/, '');

  app.setGlobalPrefix(apiPrefix);
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: apiVersion,
  });

  app.use(helmet());

  // CORS — supports literal origins AND regex patterns. Entries
  // prefixed with `re:` are compiled to RegExp; anything else is
  // matched literally. Lets the env keep a fixed list of prod
  // origins while still allowing every dev machine on the LAN
  // (192.168.x.x) and the Android emulator (10.0.2.2) to hit the
  // API from a WebView-hosted game without re-editing the env on
  // every Wi-Fi switch.
  //
  // Empty list → `origin: true` (mirror the request origin). Used
  // only when CORS_ORIGIN is unset, which we don't do in any
  // shipped environment but keeps `npm start` working out of the
  // box for a fresh checkout.
  const corsOriginsRaw = config
    .get<string>('cors.origin', '')
    .split(',')
    .filter(Boolean);
  const corsLiteral = new Set<string>();
  const corsPatterns: RegExp[] = [];
  for (const entry of corsOriginsRaw) {
    if (entry.startsWith('re:')) {
      try {
        corsPatterns.push(new RegExp(entry.slice(3)));
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.warn(`[cors] invalid regex ignored: ${entry}: ${err?.message}`);
      }
    } else {
      corsLiteral.add(entry);
    }
  }
  app.enableCors({
    origin:
      corsOriginsRaw.length === 0
        ? true
        : (origin, cb) => {
            // Non-browser callers (curl, server-to-server, mobile
            // app's Dart HttpClient) omit the Origin header — let
            // those through. Browser preflights always set Origin.
            if (!origin) return cb(null, true);
            if (corsLiteral.has(origin)) return cb(null, true);
            if (corsPatterns.some((re) => re.test(origin))) return cb(null, true);
            return cb(new Error(`CORS: origin ${origin} not allowed`));
          },
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalInterceptors(new TraceIdInterceptor(), new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableShutdownHooks();

  const port = config.get<number>('port', 3000);
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`Zimo Live backend running on http://localhost:${port}/${apiPrefix}/v${apiVersion}`);
}

bootstrap();
