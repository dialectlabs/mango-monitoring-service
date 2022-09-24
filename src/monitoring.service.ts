import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { Monitors, Pipelines } from '@dialectlabs/monitor';
import {
  MangoClient,
  Config,
  GroupConfig,
  IDS,
  getAllMarkets,
  getMultipleAccounts,
  PerpMarketLayout,
  PerpMarket,
  getMarketByPublicKey,
} from '@blockworks-foundation/mango-client';
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { ResourceId, SourceData } from '@dialectlabs/monitor';
import * as anchor from '@project-serum/anchor';
import { Duration } from 'luxon';
import {
  getAllProposals,
  getAllTokenOwnerRecords,
  getRealm,
  ProgramAccount,
  Proposal,
  Realm,
} from '@solana/spl-governance';
import { DiscordNotificationSink } from './discord-notification-sink';
import { DialectSdk } from './dialect-sdk';

const config = new Config(IDS);

const groupConfig = config.getGroupWithName(
  process.env.MANGO_CLUSTER!,
) as GroupConfig;

const connection = new Connection(
  config.cluster_urls[groupConfig.cluster],
  'processed',
);

const mangoRealmOwnerPK = new PublicKey(process.env.MANGO_REALM_OWNER_PK!);
const connectionRealm = new Connection(process.env.DIALECT_SDK_SOLANA_RPC_URL!);

export interface MarketFillsData {
  subscriber: PublicKey;
  fillOrders: FillOrderInfo[];
}

export interface FillOrderInfo {
  price: number;
  quantity: number;
  makerSlot: number;
  maker: PublicKey;
  taker: PublicKey;
  symbol: string;
  orderId: anchor.BN;
}

export interface HealthData {
  subscriber: PublicKey;
  maintHealth: number;
  beginLiquidated: number;
  mangoAccountId: PublicKey;
}

interface RealmData {
  realm: ProgramAccount<Realm>;
  proposals: ProgramAccount<Proposal>[];
  realmMembersSubscribedToNotifications: PublicKey[];
}

const unhealthyThreshold = 100;

@Injectable()
export class MonitoringService implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly sdk: DialectSdk) {}
  // private readonly notificationSink: DiscordNotificationSink =
  //   new DiscordNotificationSink();

  private readonly logger = new Logger(MonitoringService.name);

  onModuleInit() {
    const monitor = Monitors.builder({
      sdk: this.sdk,
      subscribersCacheTTL: Duration.fromObject({ minute: 5 }),
      sinks: {
        solflare: {
          apiKey: process.env.SOLFLARE_API_KEY!,
          apiUrl: process.env.SOLFLARE_API_URL!,
        },
      },
    })
      .defineDataSource<MarketFillsData>()
      .poll(
        async (subscribers) => this.getFillOrders(subscribers),
        Duration.fromObject({ seconds: 10 }),
      )
      .transform<FillOrderInfo[], FillOrderInfo[]>({
        keys: ['fillOrders'],
        pipelines: [Pipelines.added((fo1, fo2) => fo1.orderId.eq(fo2.orderId))],
      })
      .notify()
      .dialectSdk(
        (adapter) => {
          return {
            title: 'Order Filled', // Note: 'Mango: ' pre-pended in data-service
            message: this.constructMessage(adapter.value),
          };
        },
        {
          dispatch: 'unicast',
          to: ({ origin }) => origin.subscriber,
        },
      )
      .solflare(
        ({ value }) => {
          const message: string = `🥭 Mango: ` + this.constructMessage(value);
          return {
            title: '🥭 Mango: Order Filled',
            body: message,
            actionUrl: '',
          };
        },
        { dispatch: 'unicast', to: ({ origin }) => origin.subscriber },
      )
      .and()
      .build();
    monitor.start();

    const healthMonitor = Monitors.builder({
      sdk: this.sdk,
      subscribersCacheTTL: Duration.fromObject({ minute: 5 }),
      sinks: {
        solflare: {
          apiKey: process.env.SOLFLARE_API_KEY!,
          apiUrl: process.env.SOLFLARE_API_URL!,
        },
      },
    })
      .defineDataSource<HealthData>()
      .poll(
        async (subscribers) => this.getAccountHealth(subscribers),
        Duration.fromObject({ seconds: 10 }),
      )
      .transform<number, number>({
        keys: ['maintHealth'],
        pipelines: [
          Pipelines.threshold({
            type: 'falling-edge',
            threshold: unhealthyThreshold,
          }),
        ],
      })
      .notify()
      .dialectSdk(
        (adapter) => {
          return {
            title: 'Account Unhealthy', // Note: 'Mango: ' pre-pended in data-service
            message: this.constructUnhealthyMessage(adapter.value, unhealthyThreshold),
          };
        },
        {
          dispatch: 'unicast',
          to: ({ origin }) => origin.subscriber,
        },
      )
      .solflare(
        ({ value }) => {
          return {
            title: '🥭 Mango: Account is unhealthy',
            body: this.constructUnhealthyMessage(value, unhealthyThreshold),
            actionUrl: '',
          };
        },
        { dispatch: 'unicast', to: ({ origin }) => origin.subscriber },
      )
      .also()
      .transform<number, number>({
        keys: ['maintHealth'],
        pipelines: [
          Pipelines.threshold({
            type: 'rising-edge',
            threshold: unhealthyThreshold,
          }),
        ],
      })
      .notify()
      .dialectSdk(
        (adapter) => {
          return {
            title: 'Account Healthy', // Note: 'Mango: ' pre-pended in data-service
            message: this.constructHealthyMessage(adapter.value),
          };
        },
        {
          dispatch: 'unicast',
          to: ({ origin }) => origin.subscriber,
        },
      )
      .solflare(
        ({ value }) => {
          return {
            title: '🥭 Mango: Account is healthy',
            body: this.constructHealthyMessage(value),
            actionUrl: '',
          };
        },
        { dispatch: 'unicast', to: ({ origin }) => origin.subscriber },
      )
      .also()
      .transform<number, number>({
        keys: ['beginLiquidated'],
        pipelines: [
          Pipelines.threshold({
            type: 'rising-edge',
            threshold: 0.5,
          }),
        ],
      })
      .notify()
      .dialectSdk(
        (adapter) => {
          return {
            title: 'Liquidation Alert', // Note: 'Mango: ' pre-pended in data-service
            message: this.constructCriticalHealthMessage(),
          };
        },
        {
          dispatch: 'unicast',
          to: ({ origin }) => origin.subscriber,
        },
      )
      .solflare(
        ({ value }) => {
          return {
            title: '🥭 Mango: Your account is being liquidated',
            body: this.constructCriticalHealthMessage(),
            actionUrl: '',
          };
        },
        { dispatch: 'unicast', to: ({ origin }) => origin.subscriber },
      )
      .and()
      .build();
    healthMonitor.start();

    const monitorMangoDAO = Monitors.builder({
      sdk: this.sdk,
      subscribersCacheTTL: Duration.fromObject({ minute: 5 }),
      sinks: {
        solflare: {
          apiKey: process.env.SOLFLARE_API_KEY!,
          apiUrl: process.env.SOLFLARE_API_URL!,
        },
      },
    })
      .defineDataSource<RealmData>()
      .poll(
        async (subscribers) => this.getMangoProposals(subscribers),
        Duration.fromObject({ seconds: 10 }),
      )
      .transform<ProgramAccount<Proposal>[], ProgramAccount<Proposal>[]>({
        keys: ['proposals'],
        pipelines: [Pipelines.added((p1, p2) => p1.pubkey.equals(p2.pubkey))],
      })
      .notify()
      .dialectSdk(
        ({ value, context }) => {
          const realmName: string = context.origin.realm.account.name;
          const realmId: string = context.origin.realm.pubkey.toBase58();
          const message: string = this.constructMessageMango(
            realmName,
            realmId,
            value,
          );
          return {
            title: 'New Proposal', // Note: 'Mango: ' pre-pended in data-service
            message: message,
          };
        },
        {
          dispatch: 'multicast',
          to: ({ origin }) => origin.realmMembersSubscribedToNotifications,
        },
      )
      .solflare(
        ({ value, context }) => {
          const realmName: string = context.origin.realm.account.name;
          const realmId: string = context.origin.realm.pubkey.toBase58();
          const message: string = this.constructMessageMango(
            realmName,
            realmId,
            value,
          );

          return {
            title: '🥭 Mango: new proposal was created',
            body: message,
            actionUrl: '',
          };
        },
        {
          dispatch: 'multicast',
          to: ({ origin }) => {
            return origin.realmMembersSubscribedToNotifications;
          },
        },
      )
      .and()
      .build();
    monitorMangoDAO.start();
  }

  private constructUnhealthyMessage(value: number, threshold: number): string {
    return `❗️ WARNING: Your account health has dropped below the ${threshold}% threshold and is now unhealthy. It is currently at ${value.toFixed(
      2,
    )}%.`;
  }

  private constructHealthyMessage(value: number): string {
    return `✅ Your account is now healthy: ${value.toFixed(2)}%`;
  }

  private constructCriticalHealthMessage(): string {
    return `🚨 ALERT: Your account health has passed the ${0}% liquidation threshold and is being liquidated.`;
  }

  async onModuleDestroy() {
    await Monitors.shutdown();
  }

  async getAccountHealth(
    subscribers: ResourceId[],
  ): Promise<SourceData<HealthData>[]> {
    const client = new MangoClient(connection, groupConfig.mangoProgramId);
    const mangoGroup = await client.getMangoGroup(groupConfig.publicKey);
    const cache = await mangoGroup.loadCache(connection);

    const accountsPromises =
      (await Promise.allSettled(
        subscribers.map(async (subscriber) => {
          return {
            subscriber: subscriber,
            accounts: await client.getMangoAccountsForOwner(
              mangoGroup,
              new PublicKey(subscriber),
            ),
          };
        }),
      )) || [];

    const accounts = accountsPromises.map((account) => {
      if (account.status === 'fulfilled') {
        return account.value;
      }
    });

    const data = accounts
      .map((account) => {
        return account!.accounts.map((mangoAccount) => {
          return {
            groupingKey: `${account!.subscriber.toBase58()}_${mangoAccount.publicKey.toBase58()}`,
            data: {
              maintHealth: mangoAccount
                .getHealthRatio(mangoGroup, cache, 'Maint')
                .toNumber(),
              beginLiquidated: +mangoAccount.beingLiquidated,
              subscriber: account!.subscriber,
              mangoAccountId: mangoAccount.publicKey,
            },
          };
        });
      })
      .flat();
    return data;
  }

  async getFillOrders(
    subscribers: ResourceId[],
  ): Promise<SourceData<MarketFillsData>[]> {
    const client = new MangoClient(connection, groupConfig.mangoProgramId);

    const allMarketConfigs = getAllMarkets(groupConfig);
    const allMarketPks = allMarketConfigs.map((m) => m.publicKey);

    let allMarketAccountInfos: {
      publicKey: PublicKey;
      context: {
        slot: number;
      };
      accountInfo: AccountInfo<Buffer>;
    }[];

    try {
      const resp = await Promise.all([
        getMultipleAccounts(connection, allMarketPks),
      ]);
      allMarketAccountInfos = resp[0];
    } catch {
      this.logger.warn("can't fetch market account info");
    }

    const allMarketAccounts = allMarketConfigs.map((config, i) => {
      if (config.kind == 'perp') {
        const decoded = PerpMarketLayout.decode(
          allMarketAccountInfos[i].accountInfo.data,
        );
        return new PerpMarket(
          config.publicKey,
          config.baseDecimals,
          config.quoteDecimals,
          decoded,
        );
      }
    });

    const mangoGroup = await client.getMangoGroup(groupConfig.publicKey);

    const marketFills: FillOrderInfo[] = [];
    await Promise.allSettled(
      allMarketAccounts.map(async (market) => {
        const fills = await market?.loadFills(connection);
        fills?.forEach((fill) => {
          const fillOrderInfo: FillOrderInfo = {
            price: fill.price,
            quantity: fill.quantity,
            makerSlot: fill.makerSlot,
            maker: fill.maker,
            taker: fill.taker,
            symbol: getMarketByPublicKey(groupConfig, market!.publicKey)!
              .baseSymbol,
            orderId: fill.takerOrderId,
          };
          marketFills.push(fillOrderInfo);
        });
      }),
    ).then((results) =>
      results.forEach((result) => {
        if (result.status === 'rejected') {
          console.log('Market fills loading rejected');
        }
      }),
    );

    const marketFillsPromises = subscribers.map(async (subscriber) => {
      const accounts = await (
        await client.getMangoAccountsForOwner(
          mangoGroup,
          new PublicKey(subscriber),
        )
      ).map((acc) => acc.publicKey);
      const subFills: any[] = [];
      marketFills.forEach((fill: any) => {
        for (const acc of accounts) {
          if (acc.equals(fill.taker)) {
            subFills.push(fill);
          }
        }
      });
      return {
        subscriber: subscriber,
        fillOrders: subFills,
      };
    });

    const marketFillsData: any[] = await Promise.all(marketFillsPromises);

    return marketFillsData.map((it) => {
      const sourceData: SourceData<MarketFillsData> = {
        groupingKey: it.subscriber.toBase58(),
        data: {
          subscriber: it.subscriber,
          fillOrders: it.fillOrders,
        },
      };
      return sourceData;
    });
  }

  private static async getProposals(realm: ProgramAccount<Realm>) {
    const proposals = (
      await getAllProposals(connection, mangoRealmOwnerPK, realm.pubkey)
    ).flat();

    if (process.env.TEST_MODE) {
      return proposals.slice(0, Math.round(Math.random() * Math.max(0, 2)));
    }
    return proposals;
  }

  private async getMangoProposals(
    subscribers: ResourceId[],
  ): Promise<SourceData<RealmData>[]> {
    const realmId = new PublicKey(process.env.MANGO_REALM_PK!);

    const realms = await getRealm(connection, realmId);
    const proposals = await MonitoringService.getProposals(realms);

    const tokenOwnerRecords = await getAllTokenOwnerRecords(
      connectionRealm,
      mangoRealmOwnerPK,
      realms.pubkey,
    );

    const subscribersSet = Object.fromEntries(
      subscribers.map((it) => [it.toBase58(), it]),
    );

    console.log(proposals);

    const realmMembersSubscribedToNotifications: PublicKey[] = process.env
      .TEST_MODE
      ? subscribers.map((it) => [it]).flat()
      : tokenOwnerRecords
          .map((it) => it.account.governingTokenOwner)
          .filter((it) => subscribersSet[it.toBase58()])
          .map((it) => [it])
          .flat();

    console.log(realmMembersSubscribedToNotifications[0].toBase58());

    return [
      {
        groupingKey: realms.pubkey.toBase58(),
        data: {
          realm: realms,
          proposals: proposals,
          realmMembersSubscribedToNotifications,
        },
      },
    ];
  }

  private constructMessage(value: FillOrderInfo[]): string {
    let message = '';
    this.logger.log(`Constructing dialectThread notif for fills:`);
    this.logger.log({ value });
    if (value.length === 1) {
      const order = value[0];
      message = `✅ ${order.symbol} order filled for ${order.quantity} at ${order.price} USD.`;
    } else if (value.length > 1) {
      message =
        '✅ Orders filled:\n' +
        value
          .map((info) => {
            return `✅ ${info.symbol} order filled for ${info.quantity} at ${info.price} USD.`;
          })
          .join('\n');
    }
    this.logger.log(message);
    return message;
  }

  private constructMessageMango(
    realmName: string,
    realmId: string,
    proposalsAdded: ProgramAccount<Proposal>[],
  ): string {
    return [
      ...proposalsAdded.map(
        (it) =>
          `📜 New proposal for ${realmName}: https://realms.today/dao/${realmId}/proposal/${it.pubkey.toBase58()} - ${
            it.account.name
          } added by ${it.account.tokenOwnerRecord.toBase58()}`,
      ),
    ].join('\n');
  }
}
