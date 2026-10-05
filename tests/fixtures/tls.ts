import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const Tag = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  utcTime: 0x17,
  sequence: 0x30,
  set: 0x31,
  version: 0xa0,
  extensions: 0xa3,
  dnsName: 0x82,
  ipAddress: 0x87,
} as const;

const OID_COMMON_NAME = '2.5.4.3';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const RSA_KEY_BITS = 2048;
const SERIAL_BYTES = 16;
const FIRST_ARC_FACTOR = 40;
const BASE128_BITS = 7;
const BASE128_MASK = 0x7f;
const BASE128_CONTINUE = 0x80;
const LONG_LENGTH_FLAG = 0x80;
const DER_TRUE = 0xff;
const X509_VERSION_3 = 2;
const DAY_MS = 86_400_000;
const VALIDITY_DAYS = 365;
const PEM_LINE_LENGTH = 64;
const SUBJECT = 'localhost';
const LOOPBACK = [127, 0, 0, 1];

function length(size: number): Buffer {
  if (size < LONG_LENGTH_FLAG) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let remaining = size; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256);
  }
  return Buffer.from([LONG_LENGTH_FLAG | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * FIRST_ARC_FACTOR + second];
  for (const arc of rest) {
    const chunk = [arc & BASE128_MASK];
    for (let value = arc >>> BASE128_BITS; value > 0; value >>>= BASE128_BITS) {
      chunk.unshift((value & BASE128_MASK) | BASE128_CONTINUE);
    }
    bytes.push(...chunk);
  }
  return tlv(Tag.oid, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const text = date
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:T]/g, '')
    .slice(2);
  return tlv(Tag.utcTime, Buffer.from(text, 'ascii'));
}

function name(commonName: string): Buffer {
  return tlv(
    Tag.sequence,
    tlv(
      Tag.set,
      tlv(Tag.sequence, oid(OID_COMMON_NAME), tlv(Tag.utf8String, Buffer.from(commonName))),
    ),
  );
}

function extension(id: string, value: Buffer): Buffer {
  return tlv(Tag.sequence, oid(id), tlv(Tag.octetString, value));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(new RegExp(`.{1,${PEM_LINE_LENGTH}}`, 'g')) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function selfSignedCertificate(publicKey: Buffer, signTbs: (data: Buffer) => Buffer): string {
  const algorithm = tlv(Tag.sequence, oid(OID_SHA256_WITH_RSA), tlv(Tag.null));
  const serial = randomBytes(SERIAL_BYTES);
  serial[0] = (serial[0] ?? 0) & BASE128_MASK;
  const now = Date.now();
  const subject = name(SUBJECT);
  const extensions = tlv(
    Tag.extensions,
    tlv(
      Tag.sequence,
      extension(
        OID_SUBJECT_ALT_NAME,
        tlv(
          Tag.sequence,
          tlv(Tag.dnsName, Buffer.from(SUBJECT)),
          tlv(Tag.ipAddress, Buffer.from(LOOPBACK)),
        ),
      ),
      extension(
        OID_BASIC_CONSTRAINTS,
        tlv(Tag.sequence, tlv(Tag.boolean, Buffer.from([DER_TRUE]))),
      ),
    ),
  );
  const tbs = tlv(
    Tag.sequence,
    tlv(Tag.version, tlv(Tag.integer, Buffer.from([X509_VERSION_3]))),
    tlv(Tag.integer, serial),
    algorithm,
    subject,
    tlv(
      Tag.sequence,
      utcTime(new Date(now - DAY_MS)),
      utcTime(new Date(now + VALIDITY_DAYS * DAY_MS)),
    ),
    subject,
    publicKey,
    extensions,
  );
  const signature = tlv(Tag.bitString, Buffer.from([0]), signTbs(tbs));
  return pem('CERTIFICATE', tlv(Tag.sequence, tbs, algorithm, signature));
}

const keys = generateKeyPairSync('rsa', { modulusLength: RSA_KEY_BITS });
export const TEST_CERT = selfSignedCertificate(
  keys.publicKey.export({ type: 'spki', format: 'der' }),
  (data) => sign('sha256', data, keys.privateKey),
);

export const TEST_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
