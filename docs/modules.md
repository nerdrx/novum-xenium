# Modules

Small panels and extra agent tools, installed from Settings → Modules. No container rebuild or desktop reinstall for each module update.

Administrators install a ZIP, review it and enable it. Ordinary signed-in users can open enabled panels. Installing a new version closes the old panel and leaves the new version disabled. Restore brings back the previous package, also disabled until reviewed.

## Install from a GitHub repository

In **Settings → Modules**, paste `https://github.com/nerdrx/novum-xenium` and choose **Add repository**. Tick a module to download and enable it. The catalog includes Model monitor, Downloads watch, Git desk, Image studio, Research shelf, Run inbox and Focus timer. Permissions appear beside each module before activation.

A repository is pinned to its current default-branch commit. **Refresh** checks its latest catalog; **Update** downloads a new module version and leaves it disabled for review. Unticking disables a module. Forgetting a repository keeps installed modules. Public GitHub repositories are supported; private repositories and custom Git hosts are not yet supported.

## Publish a repository

Use this layout in any public GitHub repository:

```text
modules/
  index.json
  my-panel/
    module.json
    panel.html
```

`modules/index.json` lists each module directory and its package files:

```json
{
  "api_version": 1,
  "modules": [
    {"path": "my-panel", "files": ["module.json", "panel.html"]}
  ]
}
```

Paths are relative to `modules/`; files are relative to that module directory. Include assets explicitly. Keep IDs unique in the catalog. Follow the same package validation and version rules as ZIP modules. Bump the module version when changing its bytes. See the [working catalog](../modules/index.json).

## Optional read permissions

A manifest can declare `"permissions": ["models"]`. Supported grants: `downloads`, `git`, `models`, `images`, `research`, `runs`. The host mediates these requests; panels do not receive cookies or arbitrary API access. Git and model-download data require an admin account. Images, research and runs retain the signed-in user's existing ownership rules.

```js
parent.postMessage({type: 'novum:request', id: 'refresh-1', capability: 'models'}, '*');
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'novum:response') return;
  // Match event.data.id to the request; use event.data.data or show event.data.error.
});
```

Responses contain `title`, `summary`, `items` and an optional `notice`. Git requests may include a `workspace` folder, checked against the existing allowed workspace policy. Fixed `novum:open` actions (`gallery`, `research`, `tasks`, `integrations`) open the app's existing tools; arbitrary URLs and commands are not accepted.

These first panels provide read-only views, refreshed every 15 seconds while visible and on demand. Image editing and generation remain in Gallery/chat; research detail remains in Research; run approvals remain in their chats. Downloads watch covers Cookbook model downloads, not browser downloads. It does not run after its panel closes or deliver background completion alerts. Git desk shows tracked local changes, not remote pull requests or CI. Model monitor shows available models and, for administrators, loaded Ollama models and VRAM bytes; it does not unload models. These limits appear in the panels themselves.

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

A panel is an opaque sandboxed iframe. It cannot read chats, cookies, local storage, parent DOM or desktop management commands. Direct network requests, forms, nested frames and external scripts are blocked. Declared data requests travel through the host bridge. There are no package install scripts, Python hooks or native plugins.

The host sends a one-way theme message after the frame loads and when the theme changes:

```js
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'novum:theme') return;
  for (const [key, value] of Object.entries(event.data.tokens)) {
    document.documentElement.style.setProperty(`--${key}`, value);
  }
});
```

Tokens are `bg`, `fg`, `panel`, `border` and `red` (the existing accent token). Panels may request only the declared read permissions and fixed tool-opening actions described above. Use MCP for agent tools. Downloads happen only when an administrator installs or updates a module; there is no automatic marketplace installation.
