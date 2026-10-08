# Modules

Small panels and extra agent tools, installed from Settings → Modules. No container rebuild or desktop reinstall for each module update.

Administrators install a ZIP, review it and enable it. Ordinary signed-in users can open enabled panels. Installing a new version closes the old panel and leaves the new version disabled. Restore brings back the previous package, also disabled until reviewed.

## Try a panel

The [Focus timer](../examples/modules/focus-timer) is a working, self-contained example. Package it from its own directory so the manifest sits at the ZIP root:

```bash
cd examples/modules/focus-timer
python -m zipfile -c /tmp/focus-timer.zip module.json panel.html
```

Upload that ZIP in Settings → Modules, enable it, then choose Open panel. The timer lives only while its panel is open; it is not a background reminder service.

## Package format

`module.json` must sit at the ZIP root:

```json
{
  "api_version": 1,
  "id": "focus-timer",
  "name": "Focus timer",
  "version": "1.0.0",
  "description": "A small timer beside your work.",
  "panel": "panel.html"
}
```

Use a lowercase slug for the ID and major.minor.patch for the version. Keep the same ID and change the version to update a module. A currently installed version cannot be replaced by different bytes. One earlier version is available through Restore. Packages remain on disk after removal or replacement; automatic disk cleanup is not included yet.

Panels use inline JavaScript and CSS. Optional images and fonts belong under `assets/`, referenced as `assets/logo.png` from the HTML. Supported files: PNG, JPEG, GIF, WebP, ICO, WOFF and WOFF2. ZIP uploads are limited to 10 MiB, 20 MiB expanded and 100 entries; panel HTML is limited to 1 MiB.

## Agent tools

Tools use the existing MCP registry, discovery and approval rules. A module can reference already configured servers:

```json
{
  "api_version": 1,
  "id": "project-tools",
  "name": "Project tools",
  "version": "1.0.0",
  "mcp_server_ids": ["your-configured-server-id"]
}
```

Or offer a remote connection for the administrator to review:

```json
{
  "api_version": 1,
  "id": "remote-tools",
  "name": "Remote tools",
  "version": "1.0.0",
  "mcp": {
    "name": "My tool server",
    "transport": "http",
    "url": "https://tools.example.org/mcp"
  }
}
```

`http` and `sse` transports are supported. Credentials, query strings and fragments do not belong in the manifest URL. Authentication and local stdio servers are configured through Integrations.

Installation never connects a tool server. Choose Connect MCP server explicitly, or configure it in Integrations. A module may contain both a panel and tool connections. Panel enable/disable, updates, rollback and removal do not change the independent MCP connection; disconnect or remove tools in Integrations when you no longer want them available.

## Panel boundaries

A panel is an opaque sandboxed iframe. It cannot read chats, cookies, local storage, parent DOM or desktop management commands. Network requests, forms, nested frames and external scripts are blocked. There are no package install scripts, Python hooks or native plugins.

The host sends a one-way theme message after the frame loads and when the theme changes:

```js
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'novum:theme') return;
  for (const [key, value] of Object.entries(event.data.tokens)) {
    document.documentElement.style.setProperty(`--${key}`, value);
  }
});
```

Tokens are `bg`, `fg`, `panel`, `border` and `red` (the existing accent token). Panels cannot send commands back to the app. Use MCP for agent tools. This first module API does not include a marketplace, automatic downloads or access to application data.
