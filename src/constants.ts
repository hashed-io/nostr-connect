import {
  Kind,
} from 'nostr-tools/lib/event';

export const Kinds ={
    NOSTR_CONNECT: 24133 as Kind
}

export const ConnectMethods = {
  CONNECT: 'connect',
  DELEGATE: 'delegate',
  DESCRIBE: 'describe',
  DISCONNECT: 'disconnect',
  GET_PUBLIC_KEY: 'get_public_key',
  SIGN_EVENT: 'sign_event',
  SIGN_PSBT: 'sign_psbt',
  NIP04_ENCRYPT: 'nip04_encrypt',
  NIP04_DECRYPT: 'nip04_decrypt',
}
