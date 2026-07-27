import type { Icon } from '@modelcontextprotocol/server';
import type { AppConfig } from './env.js';

export const SERVER_ICON_PATH = '/icon.svg';

export function serverIcons(config: AppConfig): Icon[] {
  return [
    {
      src: new URL(SERVER_ICON_PATH, config.MCP_PUBLIC_URL).href,
      mimeType: 'image/svg+xml',
      sizes: ['any'],
      theme: 'light',
    },
  ];
}

export function serverImplementation(config: AppConfig) {
  return {
    name: config.MCP_NAME,
    title: config.MCP_TITLE,
    version: config.MCP_VERSION,
    description: config.MCP_DESCRIPTION,
    icons: serverIcons(config),
    ...(config.MCP_WEBSITE_URL ? { websiteUrl: config.MCP_WEBSITE_URL.href } : {}),
  };
}

export const SERVER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="MCP server">
  <rect width="64" height="64" rx="12" fill="#111827"/>
  <path d="M18 44V20h7l7 10 7-10h7v24h-7V31l-7 10-7-10v13z" fill="#fff"/>
</svg>`;
