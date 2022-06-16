import { DialectNotification, NotificationSink } from '@dialectlabs/monitor';
import { Logger } from '@nestjs/common';

import { Client, Intents } from "discord.js";



export class DiscordNotificationSink
  implements NotificationSink<DialectNotification>
{
  private readonly logger = new Logger(DiscordNotificationSink.name);
  // Instanciate with desired auth type (here's Bearer v2 auth)
  private discordClient =
    new Client({
        partials: ["CHANNEL", "MESSAGE"],
        intents: [
          Intents.FLAGS.GUILDS,
          Intents.FLAGS.GUILD_MESSAGES,
          Intents.FLAGS.DIRECT_MESSAGES,
        ],
    });

    constructor() {
        this.discordClient.login("OTc4NjgzNzM0OTcyODM3OTQw.Gz4Tpu.4rUMVfTkJiNP1t-D6PZKlEOUmBINreixNKArjU");
    }

    async push({ message: text }: DialectNotification): Promise<void> {
        this.logger.log(text);
        const channel = await this.discordClient?.channels?.fetch('978684488613773315');
        //@ts-ignore
        channel.messages.channel.send(text);
        return Promise.resolve();
  }
}