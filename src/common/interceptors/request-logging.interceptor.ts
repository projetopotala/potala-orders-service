import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import { redactSensitive } from '../utils/redact';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = Date.now();
    const requestIdHeader = request.headers['x-request-id'];
    const requestId =
      typeof requestIdHeader === 'string' ? requestIdHeader : undefined;

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log(
            this.formatLine(request, response.statusCode, startedAt, requestId),
          );
        },
        error: () => {
          this.logger.warn(
            this.formatLine(request, response.statusCode, startedAt, requestId),
          );
        },
      }),
    );
  }

  private formatLine(
    request: Request,
    statusCode: number,
    startedAt: number,
    requestId: string | undefined,
  ): string {
    const elapsed = Date.now() - startedAt;
    const requestIdPart = requestId ? ` requestId=${requestId}` : '';
    const line = `${request.method} ${request.originalUrl ?? request.url} ${statusCode} ${elapsed}ms${requestIdPart}`;

    if (!this.configService.get('logHttpBody', { infer: true })) {
      return line;
    }

    return `${line} body=${JSON.stringify(redactSensitive(request.body))}`;
  }
}
