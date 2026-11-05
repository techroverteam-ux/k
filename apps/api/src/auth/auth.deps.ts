import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '../config-mgmt/config.service';
import { LedgerService } from '../ledger/ledger.service';
import { DhanFeedService } from '../market/dhan-feed.service';
import { DhanGlobalFeedService } from '../market/dhan-global-feed.service';
import { YahooFeedService } from '../market/yahoo-feed.service';
import { MarketDataService } from '../market/market-data.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PolicyService } from '../policy/policy.service';
import { ConsentService } from '../consent/consent.service';
import { SimulatedVenue } from '../trading/execution-venue';
import { OrdersService } from '../trading/orders.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SmsProvider } from './sms.provider';
import { ActivityLogService } from '../logging/activity-log.service';

/** Core singletons shared by the GraphQL context factory, guards and resolvers. */
@Module({
  providers: [ActivityLogService, AuthService, PasswordService, SmsProvider, AuditService, ConfigService, LedgerService, NotificationsService, PolicyService, DhanFeedService, DhanGlobalFeedService, YahooFeedService, MarketDataService, SimulatedVenue, OrdersService, ConsentService],
  exports: [ActivityLogService, AuthService, PasswordService, SmsProvider, AuditService, ConfigService, LedgerService, NotificationsService, PolicyService, DhanFeedService, DhanGlobalFeedService, YahooFeedService, MarketDataService, SimulatedVenue, OrdersService, ConsentService],
})
export class AuthGuardDeps {}
