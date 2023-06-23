import EventEmitter from 'events';
import {
  Event,
  Kind,
  getPublicKey,
  nip04,
  nip26
} from 'nostr-tools';

import { ConnectMethods } from './constants';

import { isValidRequest, NostrRPC } from './rpc';
import { RequestOpts } from './interfaces';

export interface Metadata {
  name: string;
  url?: string;
  description?: string;
  icons?: string[];
}

export enum TimeRanges {
  FIVE_MINS = '5mins',
  ONE_HR = '1hour',
  ONE_DAY = '1day',
  ONE_WEEK = '1week',
  ONE_MONTH = '1month',
  ONE_YEAR = '1year',
}
export const TimeRangeToUnix: Record<TimeRanges, number> = {
  [TimeRanges.FIVE_MINS]: Math.round(Date.now() / 1000) + 60 * 5,
  [TimeRanges.ONE_HR]: Math.round(Date.now() / 1000) + 60 * 60,
  [TimeRanges.ONE_DAY]: Math.round(Date.now() / 1000) + 60 * 60 * 24,
  [TimeRanges.ONE_WEEK]: Math.round(Date.now() / 1000) + 60 * 60 * 24 * 7,
  [TimeRanges.ONE_MONTH]: Math.round(Date.now() / 1000) + 60 * 60 * 24 * 30,
  [TimeRanges.ONE_YEAR]: Math.round(Date.now() / 1000) + 60 * 60 * 24 * 365,
};

export class ConnectURI {
  target: string;
  metadata: Metadata;
  relay: string;

  static fromURI(uri: string): ConnectURI {
    const url = new URL(uri);
    const target = url.hostname || url.pathname.substring(2);
    if (!target) throw new Error('Invalid connect URI: missing target');
    const relay = url.searchParams.get('relay');
    if (!relay) {
      throw new Error('Invalid connect URI: missing relay');
    }
    const metadata = url.searchParams.get('metadata');
    if (!metadata) {
      throw new Error('Invalid connect URI: missing metadata');
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */
    try {
      const md = JSON.parse(metadata);
      return new ConnectURI({ target, metadata: md, relay });
    } catch (ignore) {
      throw new Error('Invalid connect URI: metadata is not valid JSON');
    }
  }

  constructor({
    target,
    metadata,
    relay,
  }: {
    target: string;
    metadata: Metadata;
    relay: string;
  }) {
    this.target = target;
    this.metadata = metadata;
    this.relay = relay;
  }

  toString() {
    return `nostrconnect://${this.target}?metadata=${encodeURIComponent(
      JSON.stringify(this.metadata)
    )}&relay=${encodeURIComponent(this.relay)}`;
  }

  async approve(secretKey: string): Promise<void> {
    const rpc = new NostrRPC({
      relay: this.relay,
      secretKey,
    });
    await rpc.call(
      {
        target: this.target,
        request: {
          method: ConnectMethods.CONNECT,
          params: [getPublicKey(secretKey)],
        },
      },
      { skipResponse: true }
    );
  }

  async reject(secretKey: string): Promise<void> {
    const rpc = new NostrRPC({
      relay: this.relay,
      secretKey,
    });
    await rpc.call(
      {
        target: this.target,
        request: {
          method: ConnectMethods.DISCONNECT,
          params: [],
        },
      },
      { skipResponse: true }
    );
  }
}

export class Connect {
  rpc: NostrRPC;
  target?: string;
  events = new EventEmitter();

  constructor({
    target,
    relay,
    secretKey,
  }: {
    secretKey: string;
    target?: string;
    relay?: string;
  }) {
    this.rpc = new NostrRPC({ relay, secretKey });
    if (target) {
      this.target = target;
    }
  }

  async init() {
    const sub = await this.rpc.listen();
    sub.on('event', async (event: Event) => {
      let payload;
      /* eslint-disable @typescript-eslint/no-unused-vars */
      try {
        const plaintext = await nip04.decrypt(
          this.rpc.self.secret,
          event.pubkey,
          event.content
        );
        if (!plaintext) throw new Error('failed to decrypt event');
        payload = JSON.parse(plaintext);
      } catch (ignore) {
        return;
      }

      // ignore all the events that are not NostrRPCRequest events
      if (!isValidRequest(payload)) return;

      switch (payload.method) {
        case ConnectMethods.CONNECT: {
          if (!payload.params || payload.params.length !== 1)
            throw new Error('connect: missing pubkey');
          const [pubkey] = payload.params;
          this.target = pubkey;
          this.events.emit('connect', pubkey);
          break;
        }
        case ConnectMethods.DISCONNECT: {
          this.target = undefined;
          this.events.emit('disconnect');
          break;
        }
        default:
      }
    });
  }

  on(evt: 'connect' | 'disconnect', cb: (...args: any[]) => void) {
    this.events.on(evt, cb);
  }
  off(evt: 'connect' | 'disconnect', cb: (...args: any[]) => void) {
    this.events.off(evt, cb);
  }

  isConnected(): boolean {
    return !this.target
  }

  assertIsConnected() {
    this.getTarget()
  }

  getTarget(): string {
    if (!this.target) throw new Error('Not connected');
    return this.target
  }

  async disconnect(): Promise<void> {
    this.assertIsConnected()
    // notify the UI that we are disconnecting
    this.events.emit('disconnect');

    try {
      await this.request(
        ConnectMethods.DISCONNECT,
        [],
        { skipResponse: true }
      );
    } catch (error) {
      throw new Error('Failed to disconnect');
    }

    this.target = undefined;
  }

  async getPublicKey(): Promise<string> {
    return this.request(
      ConnectMethods.GET_PUBLIC_KEY,
      [],
    );
  }

  async signEvent(event: {
    kind: Kind;
    tags: string[][];
    pubkey: string;
    content: string;
    created_at: number;
  }): Promise<Event> {
    return this.request(
      ConnectMethods.SIGN_EVENT,
      [event],
    );
  }

  async signPSBT(psbt: string, descriptor: string, network: string): Promise<string> {
    return this.request(
      ConnectMethods.SIGN_PSBT,
      [psbt, descriptor, network],
    );
  }


  async describe(): Promise<string[]> {
    return this.request(
      ConnectMethods.DESCRIBE,
      [],
    );
  }

  async delegate(
    delegatee: string = this.rpc.self.pubkey,
    conditions: {
      kind?: number;
      until?: number | TimeRanges;
      since?: number | TimeRanges;
    }
  ): Promise<nip26.Delegation> {
    if (conditions.until && typeof conditions.until !== 'number') {
      if (!Object.keys(TimeRangeToUnix).includes(conditions.until))
        throw new Error(
          'conditions.until must be either a number or a valid TimeRange'
        );
      conditions.until = TimeRangeToUnix[conditions.until];
    }
    if (conditions.since && typeof conditions.since !== 'number') {
      if (!Object.keys(TimeRangeToUnix).includes(conditions.since))
        throw new Error(
          'conditions.since must be either a number or a valid TimeRange'
        );
      conditions.since = TimeRangeToUnix[conditions.since];
    }

    return this.request(
      ConnectMethods.DELEGATE,
      [delegatee, conditions],
    );
  }

  async getRelays(): Promise<{
    [url: string]: { read: boolean; write: boolean };
  }> {
    throw new Error('Not implemented');
  }

  nip04 = {
    encrypt: async (pubkey: string, plaintext: string): Promise<string> => {
      return this.request(
        ConnectMethods.NIP04_ENCRYPT,
        [pubkey, plaintext],
      );
    },
    decrypt: async (pubkey: string, ciphertext: string): Promise<string> => {
      return this.request(
        ConnectMethods.NIP04_DECRYPT,
        [pubkey, ciphertext],
      );
    },
  };

  private async request(method: string, params: any[], opts?: RequestOpts): Promise<any> {
    const target = this.getTarget()
    return this.rpc.call({
      target,
      request: {
        method,
        params,
      }
    },
      opts);
  }
}
