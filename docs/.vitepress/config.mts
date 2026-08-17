import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Momus-MCP',
  description: 'Unsparing mock and test integrity auditor for coding agents',
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Executive Summary', link: '/01-executive-summary' },
    ],
    sidebar: [
      {
        text: 'Specification',
        items: [
          { text: 'Executive Summary', link: '/01-executive-summary' },
          { text: 'Architecture', link: '/02-architecture' },
          { text: 'Analysis Algorithms', link: '/03-analysis-algorithms' },
          { text: 'MCP Tool Definitions', link: '/04-mcp-tool-definitions' },
          { text: 'Output Format', link: '/05-output-format' },
          { text: 'Repository Layout', link: '/06-repository-layout' },
          { text: 'Roadmap', link: '/07-roadmap' },
          { text: 'Validation Report', link: '/09-validation-report' },
          { text: 'Build Plan', link: '/10-build-plan' },
          { text: 'Real World Findings', link: '/11-real-world-findings' },
          { text: 'Registry Listing', link: '/12-registry-listing' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/AraneaDev/Momus-MCP' }],
  },
});
