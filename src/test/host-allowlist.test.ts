import { describe, it, expect } from 'vitest';
import { hostMatchesAllowlist } from '../../src/mcp/transports.js';

describe('hostMatchesAllowlist', () => {
  it('exact match (no port on either side)', () => {
    expect(hostMatchesAllowlist('mcp.example.com', ['mcp.example.com'])).toBe(true);
  });

  it('exact match (both have same port)', () => {
    expect(hostMatchesAllowlist('mcp.example.com:3333', ['mcp.example.com:3333'])).toBe(true);
  });

  it('Host has port, allowlist has bare hostname → MATCH', () => {
    expect(hostMatchesAllowlist('mcp.example.com:3333', ['mcp.example.com'])).toBe(true);
  });

  it('Host has no port, allowlist entry has port → MATCH (hostname match wins)', () => {
    expect(hostMatchesAllowlist('mcp.example.com', ['mcp.example.com:3333'])).toBe(true);
  });

  it('Both have ports but different ports → no match', () => {
    expect(hostMatchesAllowlist('mcp.example.com:9999', ['mcp.example.com:3333'])).toBe(false);
  });

  it('Different hostnames → no match', () => {
    expect(hostMatchesAllowlist('evil.example.com:3333', ['mcp.example.com'])).toBe(false);
    expect(hostMatchesAllowlist('evil.example.com', ['mcp.example.com'])).toBe(false);
  });

  it('localhost with port vs bare localhost → MATCH', () => {
    expect(hostMatchesAllowlist('localhost:3333', ['localhost'])).toBe(true);
    expect(hostMatchesAllowlist('localhost', ['localhost:3333'])).toBe(true);
  });

  it('multiple allowlist entries — matches any', () => {
    expect(
      hostMatchesAllowlist('mcp.example.com:3333', ['localhost', 'mcp.example.com', '127.0.0.1']),
    ).toBe(true);
  });

  it('IPv6 with port — bare IPv6 in allowlist → MATCH', () => {
    expect(hostMatchesAllowlist('[::1]:3333', ['[::1]'])).toBe(true);
  });

  it('IPv6 with port vs IPv6 with port — same port → MATCH', () => {
    expect(hostMatchesAllowlist('[::1]:3333', ['[::1]:3333'])).toBe(true);
  });

  it('empty host → no match (when allowlist non-empty)', () => {
    expect(hostMatchesAllowlist('', ['mcp.example.com'])).toBe(false);
  });

  it('empty allowlist → no match (defensive: caller should skip when empty)', () => {
    expect(hostMatchesAllowlist('mcp.example.com', [])).toBe(false);
  });
});
