import { randomUUID } from 'node:crypto';

const ADDRESS_PATTERN = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const MAX_ADDRESS_LENGTH = 254;
const BASE64_LINE_LENGTH = 76;
const NON_ASCII = /[^\x20-\x7e]/;

export function isValidEmailAddress(value: string): boolean {
  return value.length <= MAX_ADDRESS_LENGTH && ADDRESS_PATTERN.test(value);
}

function encodeHeader(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ').trim();
  return NON_ASCII.test(flat)
    ? `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`
    : flat;
}

function wrapBase64(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  return (encoded.match(new RegExp(`.{1,${BASE64_LINE_LENGTH}}`, 'g')) ?? []).join('\r\n');
}

export interface MessageInput {
  from: string;
  to: readonly string[];
  subject: string;
  text: string;
  date: Date;
}

export function buildMessage(input: MessageInput): string {
  const addresses = [input.from, ...input.to];
  if (input.to.length === 0 || !addresses.every(isValidEmailAddress)) {
    throw new Error('invalid email address');
  }
  const domain = input.from.slice(input.from.indexOf('@') + 1);
  const headers = [
    `From: <${input.from}>`,
    `To: ${input.to.map((address) => `<${address}>`).join(', ')}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(input.text)}`;
}
