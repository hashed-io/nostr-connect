import EventEmitter from 'events';

import {
  Event,
  getEventHash,
  validateEvent,
  verifySignature,
  getSignature,
  nip04,
  Filter,
  getPublicKey,
  Relay,
  relayInit,
  Sub,
} from 'nostr-tools';

import { Kinds } from './constants'
import { NostrRPCRequest, NostrRPCResponse, RequestOpts } from './interfaces';

export class NostrRPC {
  relay: string;
  self: { pubkey: string; secret: string };
  event: Event | undefined;
  // this is for implementing the response handlers for each method
  [key: string]: any;
  // events
  events = new EventEmitter();

  relayCallConnection: Relay | undefined;
  relayListenConnection: Relay | undefined;

  constructor(opts: { relay: string; secretKey: string }) {
    this.relay = opts.relay
    this.self = {
      pubkey: getPublicKey(opts.secretKey),
      secret: opts.secretKey,
    };
    this.relayCallConnection = undefined;
    this.relayListenConnection = undefined;
  }

  async initRelayConnection() {
    this.relayCallConnection = await connectToRelay(this.relay);
    this.relayListenConnection = await connectToRelay(this.relay);
  }

  async call(
    {
      target,
      request: { id = randomID(), method, params = [] },
    }: {
      target: string;
      request: {
        id?: string;
        method: string;
        params?: any[];
      };
    },
    opts?: RequestOpts
  ): Promise<any> {
    // connect to relay
    const relay: Relay = this.relayCallConnection || await connectToRelay(this.relay);
    if (relay.status !== 1) await relay.connect();
    if (!this.relayCallConnection) this.relayCallConnection = relay;

    // prepare request to be sent
    const request = prepareRequest(id, method, params);
    const event = await prepareEvent(this.self.secret, target, request);
    return new Promise<void>(async (resolve, reject) => {
      const sub = relay.sub([
        {
          kinds: [Kinds.NOSTR_CONNECT],
          authors: [target],
          '#p': [this.self.pubkey],
          limit: 1,
          since: now(),
        } as Filter,
      ]);

      await broadcastToRelay(relay, event, true);

      // skip waiting for response from remote
      if (opts && opts.skipResponse === true) {
        sub.unsub();
        resolve();
      }

      sub.on('event', async (event: Event) => {
        let payload;
        /* eslint-disable @typescript-eslint/no-unused-vars */
        try {
          const plaintext = await nip04.decrypt(
            this.self.secret,
            event.pubkey,
            event.content
          );
          if (!plaintext) throw new Error('failed to decrypt event');
          payload = JSON.parse(plaintext);
        } catch (ignore) {
          return;
        }

        // ignore all the events that are not NostrRPCResponse events
        if (!isValidResponse(payload)) return;

        // ignore all the events that are not for this request
        if (payload.id !== id) return;

        // if the response is an error, reject the promise
        if (payload.error) {
          sub.unsub();
          reject(payload.error);
        }

        // if the response is a result, resolve the promise
        if (payload.result) {
          sub.unsub();
          resolve(payload.result);
        }
      });
    });
  }

  async listen(): Promise<Sub> {
    const relay = this.relayListenConnection || await connectToRelay(this.relay);
    if (relay.status !== 1) await relay.connect();
    if (!this.relayListenConnection) this.relayListenConnection = relay;
    const sub = relay.sub([
      {
        kinds: [Kinds.NOSTR_CONNECT],
        '#p': [this.self.pubkey],
        since: now(),
      } as Filter,
    ]);

    sub.on('event', async (event: Event) => {
      let payload: NostrRPCRequest;
      /* eslint-disable @typescript-eslint/no-unused-vars */
      try {
        const plaintext = await nip04.decrypt(
          this.self.secret,
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

      // handle request
      if (typeof this[payload.method] !== 'function') Promise.resolve();
      const response = await this.handleRequest(payload, event);

      const body = prepareResponse(
        response.id,
        response.result,
        response.error
      );

      const responseEvent = await prepareEvent(
        this.self.secret,
        event.pubkey,
        body
      );

      // send response via relay
      relay.publish(responseEvent);
    });

    return sub;
  }

  private async handleRequest(
    request: NostrRPCRequest,
    event: Event
  ): Promise<NostrRPCResponse> {
    const { id, method, params } = request;
    let result = null;
    let error = null;
    try {
      this.event = event;
      result = await this[method](...params);
      this.event = undefined;
    } catch (e) {
      if (e instanceof Error) {
        error = e.message;
      } else {
        error = 'unknown error';
      }
    }
    return {
      id,
      result,
      error,
    };
  }

  async disconnectRelays(): Promise<void> {
    if (this.relayCallConnection) {
      this.relayCallConnection.close();
      this.relayCallConnection = undefined;
    }
    if (this.relayListenConnection) {
      this.relayListenConnection.close();
      this.relayListenConnection = undefined;
    }
  }

}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
export function randomID(): string {
  return Math.random()
    .toString()
    .slice(2);
}
export function prepareRequest(
  id: string,
  method: string,
  params: any[]
): string {
  return JSON.stringify({
    id,
    method,
    params,
  });
}
export function prepareResponse(id: string, result: any, error: any): string {
  return JSON.stringify({
    id,
    result,
    error,
  });
}
export async function prepareEvent(
  secretKey: string,
  pubkey: string,
  content: string
): Promise<Event> {
  const cipherText = await nip04.encrypt(secretKey, pubkey, content);

  const event: Event = {
    kind: Kinds.NOSTR_CONNECT,
    created_at: now(),
    pubkey: getPublicKey(secretKey),
    tags: [['p', pubkey]],
    content: cipherText,
    id: '',
    sig: '',
  };

  const id = getEventHash(event);
  const sig = getSignature(event, secretKey);

  const signedEvent = { ...event, id, sig };
  const ok = validateEvent(signedEvent);
  const veryOk = verifySignature(signedEvent);
  if (!ok || !veryOk) {
    throw new Error('Event is not valid');
  }

  return signedEvent;
}

export function isValidRequest(payload: any): boolean {
  if (!payload) return false;

  const keys = Object.keys(payload);
  if (
    !keys.includes('id') ||
    !keys.includes('method') ||
    !keys.includes('params')
  )
    return false;

  return true;
}

export function isValidResponse(payload: any): boolean {
  if (!payload) return false;

  const keys = Object.keys(payload);
  if (
    !keys.includes('id') ||
    !keys.includes('result') ||
    !keys.includes('error')
  )
    return false;

  return true;
}

export async function connectToRelay(realayURL: string): Promise<Relay> {
  const relay = relayInit(realayURL);
  await relay.connect();
  await new Promise<void>((resolve, reject) => {
    relay.on('connect', () => {
      resolve();
    });
    relay.on('error', () => {
      reject(new Error(`not possible to connect to ${relay.url}`));
    });
  });
  return relay;
}
export async function broadcastToRelay(
  relay: Relay,
  event: Event,
  skipSeen: boolean = false
) {
  // send request via relay
  return await new Promise<void>((resolve, reject) => {
    relay.on('error', () => {
      reject(new Error(`failed to connect to ${relay.url}`));
    });
    const pub = relay.publish(event);
    if (skipSeen) resolve();
    pub.on('failed', (reason: any) => {
      reject(reason);
    });
    pub.on('ok', () => {
      resolve();
    });
  });
}
