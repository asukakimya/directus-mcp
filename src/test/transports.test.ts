import { describe, it, expect } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/config.js';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DIRECTUS_URL: 'https://directus.example.com',
    DIRECTUS_TOKEN: 'tok',
    MCP_AUTH_TOKEN: 'auth-tok',
    // strip any inherited transport
    MCP_TRANSPORT: undefined,
  };
}

describe('config transport parsing', () => {
  it('defaults to streamable-http when MCP_TRANSPORT unset', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.mcpTransport).toBe('streamable-http');
  });

  it('canonicalises legacy "http" alias to "streamable-http"', () => {
    const cfg = loadConfig({ ...baseEnv(), MCP_TRANSPORT: 'http' });
    expect(cfg.mcpTransport).toBe('streamable-http');
  });

  it('accepts "streamable-http" canonical value', () => {
    const cfg = loadConfig({ ...baseEnv(), MCP_TRANSPORT: 'streamable-http' });
    expect(cfg.mcpTransport).toBe('streamable-http');
  });

  it('accepts "stdio" for local debug', () => {
    const cfg = loadConfig({ ...baseEnv(), MCP_TRANSPORT: 'stdio' });
    expect(cfg.mcpTransport).toBe('stdio');
  });

  it('rejects unknown transport value', () => {
    expect(() =>
      loadConfig({ ...baseEnv(), MCP_TRANSPORT: 'sse' }),
    ).toThrow(/CONFIG_ERROR/);
  });

  it('case-insensitive transport parsing', () => {
    expect(loadConfig({ ...baseEnv(), MCP_TRANSPORT: 'STDIO' }).mcpTransport).toBe('stdio');
    expect(loadConfig({ ...baseEnv(), MCP_TRANSPORT: 'HTTP' }).mcpTransport).toBe('streamable-http');
    expect(loadConfig({ ...baseEnv(), MCP_TRANSPORT: 'Streamable-HTTP' }).mcpTransport).toBe('streamable-http');
  });
});

describe('config auth validation', () => {
  it('refuses to start streamable-http with requireAuth=true and empty token', () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        MCP_TRANSPORT: 'streamable-http',
        MCP_REQUIRE_AUTH: 'true',
        MCP_AUTH_TOKEN: '',
      }),
    ).toThrow(/CONFIG_ERROR.*MCP_AUTH_TOKEN/);
  });

  it('allows streamable-http with requireAuth=false and empty token', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      MCP_TRANSPORT: 'streamable-http',
      MCP_REQUIRE_AUTH: 'false',
      MCP_AUTH_TOKEN: '',
    });
    expect(cfg.mcpRequireAuth).toBe(false);
    expect(cfg.mcpAuthToken).toBe('');
  });

  it('default requireAuth=true', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.mcpRequireAuth).toBe(true);
  });
});

describe('config directus guards', () => {
  it('default allowedCollections is empty (allow any non-system)', () => {
    const cfg = loadConfig({ ...baseEnv(), DIRECTUS_ALLOWED_COLLECTIONS: '' });
    expect(cfg.allowedCollections.size).toBe(0);
  });

  it('parses comma-separated allowedCollections', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      DIRECTUS_ALLOWED_COLLECTIONS: 'articles, authors ,reviews',
    });
    expect(Array.from(cfg.allowedCollections)).toEqual(['articles', 'authors', 'reviews']);
  });

  it('default deniedCollectionPrefixes is [directus_]', () => {
    const cfg = loadConfig({ ...baseEnv(), DIRECTUS_DENIED_COLLECTION_PREFIXES: '' });
    expect(cfg.deniedCollectionPrefixes).toEqual(['directus_']);
  });

  it('default allowDelete=false', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.allowDelete).toBe(false);
  });

  it('default mutationDryRunDefault=true', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.mutationDryRunDefault).toBe(true);
  });
});

describe('config HTTP routing', () => {
  it('default mcpEndpointPath is /mcp', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.mcpEndpointPath).toBe('/mcp');
  });

  it('accepts custom MCP_ENDPOINT_PATH', () => {
    const cfg = loadConfig({ ...baseEnv(), MCP_ENDPOINT_PATH: '/api/mcp' });
    expect(cfg.mcpEndpointPath).toBe('/api/mcp');
  });

  it('prepends missing slash to endpoint path', () => {
    const cfg = loadConfig({ ...baseEnv(), MCP_ENDPOINT_PATH: 'mcp' });
    expect(cfg.mcpEndpointPath).toBe('/mcp');
  });

  it('rejects endpoint path with path traversal', () => {
    expect(() => loadConfig({ ...baseEnv(), MCP_ENDPOINT_PATH: '/mcp/../admin' })).toThrow(/CONFIG_ERROR/);
    expect(() => loadConfig({ ...baseEnv(), MCP_ENDPOINT_PATH: '//mcp' })).toThrow(/CONFIG_ERROR/);
  });

  it('strips query string from endpoint path', () => {
    const cfg = loadConfig({ ...baseEnv(), MCP_ENDPOINT_PATH: '/mcp?foo=bar' });
    expect(cfg.mcpEndpointPath).toBe('/mcp');
  });

  it('default mcpBindHost is 0.0.0.0', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.mcpBindHost).toBe('0.0.0.0');
  });

  it('accepts custom MCP_BIND_HOST', () => {
    const cfg = loadConfig({ ...baseEnv(), MCP_BIND_HOST: '127.0.0.1' });
    expect(cfg.mcpBindHost).toBe('127.0.0.1');
  });

  it('falls back to 0.0.0.0 when MCP_BIND_HOST empty', () => {
    const cfg = loadConfig({ ...baseEnv(), MCP_BIND_HOST: '' });
    expect(cfg.mcpBindHost).toBe('0.0.0.0');
  });

  it('parses MCP_ALLOWED_ORIGINS as array', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      MCP_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com',
    });
    expect(cfg.mcpAllowedOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('default mcpAllowedOrigins is empty', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.mcpAllowedOrigins).toEqual([]);
  });

  it('parses MCP_ALLOWED_HOSTS as lowercased array', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      MCP_ALLOWED_HOSTS: 'MCP.Example.com, localhost:3333',
    });
    expect(cfg.mcpAllowedHosts).toEqual(['mcp.example.com', 'localhost:3333']);
  });
});

describe('config mutationRequireVerify', () => {
  it('default mutationRequireVerify=true', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.mutationRequireVerify).toBe(true);
  });

  it('can be disabled via env', () => {
    const cfg = loadConfig({ ...baseEnv(), MUTATION_REQUIRE_VERIFY: 'false' });
    expect(cfg.mutationRequireVerify).toBe(false);
  });
});

describe('config operation-specific plan policy', () => {
  it('falls back to APPLY_REQUIRES_PLAN for create, update, delete, and bulk', () => {
    const cfg = loadConfig({ ...baseEnv(), APPLY_REQUIRES_PLAN: 'false' });
    expect(cfg.applyRequiresPlan).toBe(false);
    expect(cfg.createRequiresPlan).toBe(false);
    expect(cfg.updateRequiresPlan).toBe(false);
    expect(cfg.deleteRequiresPlan).toBe(false);
    expect(cfg.bulkRequiresPlan).toBe(false);
    expect(cfg.updateByQueryRequiresPlan).toBe(true);
  });

  it('allows operation-specific overrides', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      APPLY_REQUIRES_PLAN: 'true',
      CREATE_REQUIRES_PLAN: 'false',
      UPDATE_REQUIRES_PLAN: 'true',
      DELETE_REQUIRES_PLAN: 'true',
      BULK_REQUIRES_PLAN: 'true',
    });
    expect(cfg.createRequiresPlan).toBe(false);
    expect(cfg.updateRequiresPlan).toBe(true);
    expect(cfg.deleteRequiresPlan).toBe(true);
    expect(cfg.bulkRequiresPlan).toBe(true);
  });
});

/**
 * Host allowlist port/hostname tolerance — exercised through the
 * `hostMatchesAllowlist` helper. We test the behaviour indirectly
 * via config parsing (the function is internal to transports.ts but
 * the parsing of MCP_ALLOWED_HOSTS is config-level).
 */
describe('config MCP_ALLOWED_HOSTS parsing', () => {
  it('lowercases host entries', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      MCP_ALLOWED_HOSTS: 'MCP.Example.com, LOCALHOST:3333',
    });
    expect(cfg.mcpAllowedHosts).toEqual(['mcp.example.com', 'localhost:3333']);
  });

  it('preserves port in allowlist entries', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      MCP_ALLOWED_HOSTS: 'mcp.example.com:3333,localhost',
    });
    expect(cfg.mcpAllowedHosts).toEqual(['mcp.example.com:3333', 'localhost']);
  });

  it('empty MCP_ALLOWED_HOSTS = allow any host', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.mcpAllowedHosts).toEqual([]);
  });
});
