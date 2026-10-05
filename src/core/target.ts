import { isIP } from 'node:net';

const MAX_PORT = 65535;
const MAX_HOSTNAME_LENGTH = 253;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*$/;

export interface HostPort {
  host: string;
  port: number;
}

export function isValidHost(host: string): boolean {
  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) return false;
  return isIP(host) !== 0 || HOSTNAME_PATTERN.test(host);
}

export function parseHostPort(target: string): HostPort | null {
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(target);
  const plain = /^([^:[\]\s]+):(\d{1,5})$/.exec(target);
  const match = bracketed ?? plain;
  const host = match?.[1];
  const portText = match?.[2];
  if (host === undefined || portText === undefined) return null;
  const port = Number(portText);
  if (port < 1 || port > MAX_PORT || !isValidHost(host)) return null;
  return { host, port };
}

export function redactTarget(target: string): string {
  try {
    const url = new URL(target);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.protocol}//${url.host}${url.pathname}`
      : target;
  } catch {
    return target;
  }
}
