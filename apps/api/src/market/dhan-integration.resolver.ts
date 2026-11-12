import { Controller, Get, Query as HttpQuery, Req, Res } from '@nestjs/common';
import { Field, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Request, Response } from 'express';
import { CurrentActor, Roles } from '../common/context';
import type { Actor } from '../common/context';
import { DhanCredentialsService } from './dhan-credentials.service';
import { DhanCatalogService } from './dhan-catalog.service';
import { MarketDataService } from './market-data.service';
import { env } from '../config/env';

@ObjectType()
class DhanIntegrationStatus {
  @Field() configured!: boolean;
  @Field() connected!: boolean;
  @Field() mode!: string;
  @Field({ nullable: true }) expiresAt?: string;
  @Field() catalogJson!: string;
  @Field() feedJson!: string;
}
@Resolver()
export class DhanIntegrationResolver {
  constructor(
    private readonly credentials: DhanCredentialsService,
    private readonly catalog: DhanCatalogService,
    private readonly market: MarketDataService,
  ) {}
  @Roles('SUPER_ADMIN')
  @Query(() => DhanIntegrationStatus)
  async dhanIntegrationStatus() {
    return {
      ...(await this.credentials.status()),
      catalogJson: JSON.stringify(await this.catalog.status()),
      feedJson: JSON.stringify({
        instruments: this.market.instrumentCount(),
        freshQuotes: this.market.all().filter((q) => q.source === 'DHAN' && Date.now() - q.ts.getTime() < 60000).length,
      }),
    };
  }
  @Roles('SUPER_ADMIN')
  @Mutation(() => String)
  beginDhanConnection(@CurrentActor() actor: Actor) {
    return this.credentials.begin(actor);
  }
  @Roles('SUPER_ADMIN')
  @Mutation(() => String)
  async syncDhanCatalog() {
    return JSON.stringify(await this.catalog.sync());
  }
}

@Controller('integrations/dhan')
export class DhanIntegrationController {
  constructor(private readonly credentials: DhanCredentialsService) {}
  @Get('start')
  async start(@HttpQuery('ticket') ticket: string, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const result = await this.credentials.start(ticket);
      res.cookie('dhan_connect', result.cookie, {
        httpOnly: true,
        secure: env().COOKIE_SECURE,
        sameSite: 'lax',
        path: '/integrations/dhan',
        maxAge: 15 * 60_000,
      });
      res.redirect(303, result.url);
    } catch {
      res
        .status(400)
        .type('text/plain')
        .send('Could not start Dhan login. Return to the Super Admin market-data panel and reconnect.');
    }
  }
  @Get('callback')
  async complete(@HttpQuery('tokenId') tokenId: string, @Req() req: Request, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      await this.credentials.complete(req.cookies?.dhan_connect, tokenId);
      res.clearCookie('dhan_connect', { path: '/integrations/dhan' });
      res.redirect(303, new URL('/admin/market-data?dhan=connected', env().WEB_APP_URL).toString());
    } catch {
      res.clearCookie('dhan_connect', { path: '/integrations/dhan' });
      res
        .status(400)
        .type('text/plain')
        .send('Dhan connection was not completed. Return to the app and start Connect Dhan again.');
    }
  }
}
