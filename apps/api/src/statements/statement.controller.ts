import { Controller, Get, HttpException, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '../common/errors';
import { clientIp, requestContext } from '../common/request-context';
import { ActivityLogService } from '../logging/activity-log.service';
import { StatementService } from './statement.service';

/** GET /statement.pdf?token=… — the token comes from the statementLink mutation and expires in 2 minutes. */
@Controller()
export class StatementController {
  constructor(
    private readonly statements: StatementService,
    private readonly activity: ActivityLogService,
  ) {}

  @Get('statement.pdf')
  async download(@Query('token') token: string, @Req() req: Request, @Res() res: Response) {
    const rc = requestContext.get();
    let outcome: 'OK' | 'ERROR' = 'ERROR';
    let errorCode: string | null = null;
    let userId: string | undefined;
    res.on('finish', () => {
      if (rc) this.activity.record({ rc, userId, opType: 'http', opName: 'statement.pdf', fields: 'GET /statement.pdf', variables: null, outcome, errorCode, durationMs: Date.now() - rc.startedAt });
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (typeof token !== 'string' || token.length > 2000) throw new AppError('UNAUTHENTICATED', 'Link expired.');
      const claims = this.statements.verify(token);
      userId = claims.sub;
      const { pdf, fileName } = await this.statements.render(claims, requestContext.get()?.ip ?? clientIp(req));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`);
      outcome = 'OK';
      res.send(pdf);
    } catch (e) {
      const unauth = e instanceof AppError && e.extensions.code === 'UNAUTHENTICATED';
      if (!unauth && !(e instanceof HttpException) && !(e instanceof AppError)) throw e;
      errorCode = unauth ? 'UNAUTHENTICATED' : 'BAD_USER_INPUT';
      res.status(unauth ? 401 : 400).type('text/plain').send(unauth ? 'This download link has expired. Please generate the statement again.' : (e as Error).message);
    }
  }
}
