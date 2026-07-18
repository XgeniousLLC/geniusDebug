import { Controller, Get, Req, Res, Catch, HttpException } from '@nestjs/common';
import type { ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  wantsHtml,
  homePage,
  homeJson,
  notFoundPage,
  notFoundJson,
  errorPage,
  errorJson,
  type ServiceName,
} from '@geniusdebug/shared';

const SERVICE: ServiceName = 'api';

/** Root landing page — HTML for browsers, JSON for API clients. */
@Controller()
export class RootController {
  @Get()
  root(@Req() req: Request, @Res() res: Response) {
    if (wantsHtml(req.headers.accept)) return res.type('html').send(homePage(SERVICE));
    return res.json(homeJson(SERVICE));
  }
}

/**
 * Catch-all filter: browsers get themed 404/500 pages; API/SPA clients keep the
 * JSON error contract. 4xx HttpExceptions (400/401/403…) pass through with Nest's
 * original JSON body so the dashboard's error handling is unchanged.
 */
@Catch()
export class HtmlExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const html = wantsHtml(req.headers.accept);

    if (status === 404) {
      return html ? res.status(404).type('html').send(notFoundPage(SERVICE)) : res.status(404).json(notFoundJson(SERVICE));
    }
    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error(`[${SERVICE}] ${req.method} ${req.url} →`, exception instanceof Error ? exception.stack : exception);
      return html ? res.status(status).type('html').send(errorPage(SERVICE)) : res.status(status).json(errorJson(SERVICE));
    }
    const body = exception instanceof HttpException ? exception.getResponse() : errorJson(SERVICE);
    return res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}
