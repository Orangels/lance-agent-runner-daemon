import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { WebhookConfig } from '../config/profiles.js';
import { daemonError } from './errors.js';

export type WebhookDnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const blockedPorts = new Set([
  '1',
  '7',
  '9',
  '11',
  '13',
  '15',
  '17',
  '19',
  '20',
  '21',
  '22',
  '23',
  '25',
  '69',
  '110',
  '137',
  '138',
  '139',
  '143',
  '161',
  '389',
  '445',
  '587',
]);

export async function assertWebhookUrlAllowed(input: {
  url: string;
  config: WebhookConfig;
  lookup?: WebhookDnsLookup;
}): Promise<URL> {
  const parsed = parseWebhookUrl(input.url);
  if (parsed.protocol === 'http:' && !input.config.allowInsecureHttp) {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL must use https', 400);
  }
  if (parsed.username || parsed.password) {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL credentials are not allowed', 400);
  }
  if (parsed.hash) {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL fragments are not allowed', 400);
  }
  if (parsed.port && blockedPorts.has(parsed.port)) {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL port is not allowed', 400);
  }
  if (input.config.allowedHosts.length > 0 && !hostMatches(parsed.hostname, input.config.allowedHosts)) {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL host is not allowed', 400);
  }

  const resolver = input.lookup ?? defaultLookup;
  const addresses = await resolver(parsed.hostname);
  if (addresses.length === 0) {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL host did not resolve', 400);
  }
  for (const record of addresses) {
    assertAddressAllowed({
      address: record.address,
      hostname: parsed.hostname,
      config: input.config,
    });
  }
  return parsed;
}

function parseWebhookUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL is invalid', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL protocol is not allowed', 400);
  }
  return parsed;
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return lookup(hostname, { all: true });
}

function assertAddressAllowed(input: {
  address: string;
  hostname: string;
  config: WebhookConfig;
}): void {
  if (hostMatches(input.hostname, input.config.allowedHosts)) {
    return;
  }
  const ipv4 = parseWebhookAddressIpv4(input.address);
  if (!ipv4) {
    if (isIP(input.address) === 6) {
      throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL IPv6 address is not allowed', 400);
    }
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL resolved address is not allowed', 400);
  }
  const range = classifyIpv4(ipv4.value);
  if (range === 'public') {
    return;
  }
  if (!input.config.allowPrivateNetworks) {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL resolves to a private address', 400);
  }
  if (!input.config.allowedPrivateCidrs.some((cidr) => ipv4InCidr(ipv4.value, cidr))) {
    throw daemonError('WEBHOOK_URL_NOT_ALLOWED', 'webhook URL private address is not allowed', 400);
  }
}

function hostMatches(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((host) => host.toLowerCase() === hostname.toLowerCase());
}

function parseWebhookAddressIpv4(value: string): { value: number } | null {
  const direct = parseIpv4(value);
  if (direct) {
    return direct;
  }
  const ipv4MappedPrefix = '::ffff:';
  if (value.toLowerCase().startsWith(ipv4MappedPrefix)) {
    return parseIpv4(value.slice(ipv4MappedPrefix.length));
  }
  return null;
}

function parseIpv4(value: string): { value: number } | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const parsed = Number(part);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) return null;
    result = (result << 8) + parsed;
  }
  return { value: result >>> 0 };
}

function classifyIpv4(value: number): 'public' | 'private' {
  if (ipv4InCidrValue(value, 0x0a000000, 8)) return 'private';
  if (ipv4InCidrValue(value, 0xac100000, 12)) return 'private';
  if (ipv4InCidrValue(value, 0xc0a80000, 16)) return 'private';
  if (ipv4InCidrValue(value, 0x7f000000, 8)) return 'private';
  if (ipv4InCidrValue(value, 0xa9fe0000, 16)) return 'private';
  if (ipv4InCidrValue(value, 0x00000000, 8)) return 'private';
  if (ipv4InCidrValue(value, 0xe0000000, 4)) return 'private';
  return 'public';
}

function ipv4InCidr(value: number, cidr: string): boolean {
  const [base, bitsValue] = cidr.split('/');
  const baseIp = base ? parseIpv4(base) : null;
  const bits = Number(bitsValue);
  if (!baseIp || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  return ipv4InCidrValue(value, baseIp.value, bits);
}

function ipv4InCidrValue(value: number, base: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}
