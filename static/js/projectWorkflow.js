/** Mount the optional project-workflow panel into an existing UI container. */
export function mountProjectWorkflow(container, initialWorkspace = "", { fetcher = fetch, onSelectWorkspace, getSessionId } = {}) {
  if (!container) throw new TypeError("Project workflow container is required");
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label) => {
    const node = el("button", label);
    node.type = "button";
    return node;
  };
  const panel = el("section");
  panel.className = "project-workflow-panel";
  panel.setAttribute("aria-labelledby", `project-workflow-title-${++panelCounter}`);
  const title = el("h2", "Project workflow");
  title.id = panel.getAttribute("aria-labelledby");
  panel.append(title, el("p", "Review repository guidance and the compact map before creating a worktree. Repository instructions are never executed automatically."));

  const pathLabel = el("label", "Workspace path ");
  const pathInput = el("input");
  pathInput.type = "text";
  pathInput.autocomplete = "off";
  pathInput.value = initialWorkspace;
  pathLabel.append(pathInput);
  const inspectButton = button("Inspect project");
  const createButton = button("Create worktree");
  panel.append(pathLabel, inspectButton, createButton);

  const capabilityButton = button("Check capabilities");
  const evidenceButton = button("Run evidence");
  const copyButton = button("Copy report");
  const downloadButton = button("Download JSON");
  panel.append(capabilityButton, evidenceButton, copyButton, downloadButton);

  const live = el("p");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  panel.append(live);
  const report = el("div");
  report.setAttribute("aria-label", "Project workflow results");
  panel.append(report);
  let lastReport = null;

  const configTitle = el("h3", "Verification checks");
  const configHelp = el("p", "Add a check, then enter its executable and one argument per line. Arguments are passed directly; no shell parsing is used.");
  const checkList = el("div");
  checkList.setAttribute("aria-label", "Verification checks");
  const addCheckButton = button("Add check");
  const advanced = el("details");
  const advancedSummary = el("summary", "Advanced JSON");
  const configLabel = el("label", "Checks JSON ");
  const config = el("textarea");
  config.rows = 7;
  config.spellcheck = false;
  config.value = JSON.stringify([{ name: "Tests", argv: ["python", "-m", "pytest", "-q"], required: true, timeout_seconds: 120 }], null, 2);
  configLabel.append(config);
  const applyJsonButton = button("Apply JSON to fields");
  advanced.append(advancedSummary, configLabel, applyJsonButton);
  const autoRunLabel = el("label", " Run these checks automatically after agent edits ");
  const autoRun = el("input");
  autoRun.type = "checkbox";
  autoRun.checked = false;
  autoRunLabel.prepend(autoRun);
  const saveButton = button("Save checks");
  panel.append(configTitle, configHelp, checkList, addCheckButton, advanced, autoRunLabel, saveButton);

  let jsonEdited = false;
  config.addEventListener("input", () => { jsonEdited = true; });
  const renderChecks = (checks) => {
    checkList.replaceChildren();
    for (const [index, check] of checks.entries()) {
      const row = el("fieldset");
      row.className = "project-workflow-check";
      const legend = el("legend", check.name || `Check ${index + 1}`);
      const nameLabel = el("label", "Name ");
      const name = el("input"); name.value = check.name || ""; nameLabel.append(name);
      const executableLabel = el("label", "Executable ");
      const executable = el("input"); executable.value = check.argv?.[0] || ""; executableLabel.append(executable);
      const argsLabel = el("label", "Arguments (one per line) ");
      const args = el("textarea"); args.rows = 3; args.value = (check.argv || []).slice(1).join("\n"); argsLabel.append(args);
      const timeoutLabel = el("label", "Timeout (seconds) ");
      const timeout = el("input"); timeout.type = "number"; timeout.min = "1"; timeout.max = "600"; timeout.value = check.timeout_seconds || 120; timeoutLabel.append(timeout);
      const requiredLabel = el("label", "Required ");
      const required = el("input"); required.type = "checkbox"; required.checked = check.required !== false; requiredLabel.prepend(required);
      const remove = button(`Remove ${check.name || `check ${index + 1}`}`);
      remove.addEventListener("click", () => renderChecks(readChecks().filter((_, i) => i !== index)));
      row.append(legend, nameLabel, executableLabel, argsLabel, timeoutLabel, requiredLabel, remove);
      checkList.append(row);
    }
    config.value = JSON.stringify(checks, null, 2);
    jsonEdited = false;
  };
  renderChecks(JSON.parse(config.value));
  addCheckButton.addEventListener("click", () => renderChecks([...readChecks(), { name: "", argv: [""], required: true, timeout_seconds: 120 }]));
  function readChecks() {
    return [...checkList.querySelectorAll("fieldset")].map((row) => {
      const inputs = row.querySelectorAll("input, textarea");
      return { name: inputs[0].value.trim(), argv: [inputs[1].value, ...inputs[2].value.split("\n").filter((arg) => arg !== "")], timeout_seconds: Number(inputs[3].value), required: inputs[4].checked };
    });
  }
  function validateChecks(checks) {
    if (!Array.isArray(checks) || checks.some((check) => !check || !check.name?.trim()
      || !Array.isArray(check.argv) || !check.argv.length || check.argv.some((arg) => typeof arg !== "string" || !arg)
      || !Number.isInteger(check.timeout_seconds) || check.timeout_seconds < 1 || check.timeout_seconds > 600)) {
      throw new Error("Each check needs a name, executable, and timeout from 1 to 600 seconds.");
    }
    return checks;
  }
  applyJsonButton.addEventListener("click", () => {
    try { renderChecks(validateChecks(JSON.parse(config.value))); status("JSON applied to the check fields."); }
    catch (error) { status(`Could not apply JSON: ${error.message}`); }
  });
  checkList.addEventListener("input", () => { config.value = JSON.stringify(readChecks(), null, 2); jsonEdited = false; });

  const worktreeTitle = el("h3", "Managed worktrees");
  const worktreeList = el("ul");
  panel.append(worktreeTitle, worktreeList);
  container.replaceChildren(panel);

  let selectedWorkspace = "";
  let closed = false;
  let busy = false;
  let refreshPromise = null;
  const controller = new AbortController();
  const status = (message) => { if (!closed) live.textContent = message; };
  const api = async (url, options = {}) => {
    const response = await fetcher(url, {
      ...options,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    return data;
  };
  const show = (value) => {
    if (!closed) {
      lastReport = value;
      report.replaceChildren();
      if (value && Array.isArray(value.results)) {
        const statusLabel = { awaiting_approval: "Awaiting approval", awaiting_input: "Awaiting input", paused: "Paused", unverified: "Unverified" };
        const overall = statusLabel[value.status] || (value.complete ? "Verification passed" : value.results.some((result) => result.required && !result.passed) ? "Verification failed" : "Verification incomplete");
        report.append(el("h3", overall));
        if (value.reason) report.append(el("p", value.reason));
        for (const result of value.results) {
          const row = el("section");
          const state = statusLabel[result.status] || (result.passed ? "Passed" : "Failed");
          row.append(el("h4", `${state} · ${result.name}${result.required ? " (required)" : " (optional)"}`));
          const output = el("pre", result.output || "No output");
          row.append(output);
          report.append(row);
        }
      } else if (value && value.model && value.backends && value.execution) {
        report.append(el("h3", "Capability check"), el("p", "This checks saved configuration and the current tool inventory. It does not call the model or test provider reachability."));
        const labels = { available: "Available", connected: "Connected", disabled: "Disabled", unavailable: "Unavailable", configured_unverified: "Configured; not tested", misconfigured: "Needs configuration", not_configured: "Not configured", claimed: "Declared by endpoint; not tested", unsupported: "Not supported", unknown: "Unknown" };
        const row = (name, state, reason = "") => {
          const section = el("section");
          section.append(el("h4", name), el("p", labels[state] || state || "Unknown"));
          if (reason) section.append(el("p", reason));
          report.append(section);
        };
        row(value.model.id || "Model", value.model.tool_calling?.status, "Tool calling support comes from endpoint configuration.");
        const context = value.model.context_window || {};
        row("Context window", context.tokens ? `${Number(context.tokens).toLocaleString()} tokens (registry estimate)` : "Unknown", context.reason);
        row("Model endpoint", !value.endpoint?.configured ? "Not configured" : value.endpoint.enabled ? "Configured; not tested" : "disabled");
        for (const [key, name] of [["search", "Web search"], ["browser", "Browser"], ["image_generation", "Image generation"]]) {
          const backend = value.backends[key] || {};
          row(name, backend.status, backend.reason);
        }
        row("Shell execution", value.execution.mode === "separate_container" ? value.execution.status : "Runs in the app container/process", value.execution.mode === "separate_container" ? "Worker configuration does not prove reachability." : "Workspace folders scope file tools; shell commands can reach outside them.");
        const items = value.tools?.items || [];
        row("Tool inventory", `${items.filter((tool) => tool.availability === "available").length} available · ${items.filter((tool) => tool.availability === "disabled").length} disabled`, "Available tools are loaded on demand; the model may not use every tool.");
        if (value.latest_run) row("Latest run", value.latest_run.status, `${value.latest_run.duration_seconds ?? "?"} seconds`);
      } else if (value && Array.isArray(value.runs)) {
        report.append(el("h3", "Run evidence"));
        const labels = { done: "Finished", running: "Running", error: "Failed", stopped: "Stopped", interrupted: "Interrupted", awaiting_approval: "Awaiting approval", awaiting_input: "Awaiting your answer", paused: "Paused at a limit", unverified: "Verification incomplete" };
        if (!value.runs.length) report.append(el("p", "No recorded runs for this chat yet."));
        for (const run of value.runs) {
          const section = el("section");
          section.append(el("h4", labels[run.status] || run.status), el("p", `${run.model || "Unknown model"} · ${run.duration_seconds ?? "?"} seconds · ${(run.events || []).length} recorded events`));
          report.append(section);
        }
      } else if (value && (value.instructions || value.workspace_map)) {
        report.append(el("h3", "Project inspection"));
        if (value.repository) report.append(el("p", `Repository: ${value.repository}`));
        if (value.workspace_map?.length) {
          report.append(el("h4", "Workspace map"));
          const map = el("ul");
          for (const path of value.workspace_map) map.append(el("li", path));
          report.append(map);
        }
        if (value.map_truncated) report.append(el("p", "This workspace map is partial. Files omitted here are still on disk."));
        if (value.instructions?.length) {
          report.append(el("h4", "Repository guidance (review only)"));
          for (const instruction of value.instructions) {
            const section = el("section");
            section.append(el("h4", instruction.path || (instruction.path_available === false ? "Guidance (filename unavailable)" : "Guidance")), el("p", instruction.content || ""));
            report.append(section);
          }
        }
      } else {
        const formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        report.append(el("pre", formatted));
      }
    }
  };
  const setBusy = (isBusy, message) => {
    if (closed) return;
    busy = !!isBusy;
    for (const node of panel.querySelectorAll("button, input, textarea")) node.disabled = busy;
    status(message);
  };
  const refreshWorktrees = async (force = false) => {
    if (refreshPromise && !force) return refreshPromise;
    if (refreshPromise && force) await refreshPromise.catch(() => {});
    if (closed) return;
    refreshPromise = (async () => {
      const data = await api("/api/project-workflows/worktrees");
      if (closed) return;
      worktreeList.replaceChildren();
      for (const worktree of data.worktrees || []) {
        const row = el("li");
        const summary = el("span", `${worktree.repository} → ${worktree.path} (${String(worktree.commit || "").slice(0, 12)})`);
        const runButton = button("Run checks");
        const removeButton = button("Remove worktree");
        runButton.addEventListener("click", async () => {
          if (busy || closed) return;
          setBusy(true, "Running configured checks…");
          try {
            const result = await api(`/api/project-workflows/worktrees/${encodeURIComponent(worktree.id)}/verify`, { method: "POST" });
            show(result);
            status(result.complete ? "All required checks passed." : result.reason || "Verification incomplete. Review the check results.");
          } catch (error) { status(error.message); }
          finally { setBusy(false, live.textContent); }
        });
        removeButton.addEventListener("click", async () => {
          if (busy || closed) return;
          setBusy(true, "Removing worktree safely…");
          try {
            show(await api(`/api/project-workflows/worktrees/${encodeURIComponent(worktree.id)}`, { method: "DELETE" }));
            await refreshWorktrees(true);
            status("Worktree removed. Dirty or ignored worktrees are preserved.");
          } catch (error) { status(error.message); }
          finally { setBusy(false, live.textContent); }
        });
        row.append(summary, document.createTextNode(" "));
        if (onSelectWorkspace) {
          const useButton = button("Use this worktree");
          useButton.addEventListener("click", () => {
            if (busy || closed) return;
            selectedWorkspace = worktree.path;
            pathInput.value = worktree.path;
            try {
              onSelectWorkspace(worktree.path);
              status("Worktree selected as the active workspace.");
            } catch (error) { status(error.message); }
          });
          row.append(useButton, document.createTextNode(" "));
        }
        row.append(runButton, document.createTextNode(" "), removeButton);
        worktreeList.append(row);
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };

  inspectButton.addEventListener("click", async () => {
    if (busy || closed) return;
    setBusy(true, "Inspecting bounded repository metadata…");
    try {
      const result = await api("/api/project-workflows/inspect", {
        method: "POST", body: JSON.stringify({ workspace: pathInput.value.trim() }),
      });
      selectedWorkspace = result.repository;
      pathInput.value = result.repository;
      show(result);
      const saved = await api(`/api/project-workflows/verification?workspace=${encodeURIComponent(selectedWorkspace)}`);
      config.value = JSON.stringify(saved.checks || [], null, 2);
      renderChecks(saved.checks || []);
      autoRun.checked = saved.auto_run_on_completion === true;
      status("Inspection ready. Review the returned guidance and map.");
    } catch (error) { status(error.message); }
    finally { setBusy(false, live.textContent); }
  });

  createButton.addEventListener("click", async () => {
    if (busy || closed) return;
    setBusy(true, "Creating an isolated detached worktree…");
    try {
      const record = await api("/api/project-workflows/worktrees", {
        method: "POST", body: JSON.stringify({ workspace: (selectedWorkspace || pathInput.value).trim() }),
      });
      show(record);
      await refreshWorktrees(true);
      status("Worktree ready. Save reviewed checks before running verification.");
    } catch (error) { status(error.message); }
    finally { setBusy(false, live.textContent); }
  });

  saveButton.addEventListener("click", async () => {
    if (busy || closed) return;
    const workspace = selectedWorkspace || pathInput.value.trim();
    if (!workspace) { status("Inspect a workspace first."); return; }
    let checks;
    try {
      checks = jsonEdited ? JSON.parse(config.value) : readChecks();
      validateChecks(checks);
      renderChecks(checks);
    }
    catch (error) { status(`Could not save checks: ${error.message}`); return; }
    setBusy(true, "Saving reviewed verification checks…");
    try {
      show(await api("/api/project-workflows/verification", {
        method: "PUT", body: JSON.stringify({ workspace, checks, auto_run_on_completion: autoRun.checked }),
      }));
      status(autoRun.checked ? "Checks saved. They will gate completion after agent edits." : "Checks saved. Automatic completion checks are off.");
    } catch (error) { status(error.message); }
    finally { setBusy(false, live.textContent); }
  });

  const runSessionReport = async (kind) => {
    if (busy || closed) return;
    let session = "";
    try { session = await (typeof getSessionId === "function" ? getSessionId() : ""); }
    catch (error) { status(error.message); return; }
    if (!session) { status("Open a chat session first."); return; }
    setBusy(true, kind === "evidence" ? "Collecting evidence…" : "Checking capabilities…");
    try {
      const workspace = (selectedWorkspace || pathInput.value).trim();
      const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
      const url = kind === "evidence"
        ? `/api/chat/evidence/${encodeURIComponent(session)}`
        : `/api/harness/preflight/${encodeURIComponent(session)}${query}`;
      const result = await api(url);
      show(result);
      status(kind === "evidence" ? "Evidence report ready." : "Capability report ready.");
    } catch (error) { status(error.message); }
    finally { setBusy(false, live.textContent); }
  };
  capabilityButton.addEventListener("click", () => runSessionReport("capabilities"));
  evidenceButton.addEventListener("click", () => runSessionReport("evidence"));
  copyButton.addEventListener("click", async () => {
    if (busy || closed || lastReport === null) return;
    try {
      await navigator.clipboard.writeText(typeof lastReport === "string" ? lastReport : JSON.stringify(lastReport, null, 2));
      status("Report copied.");
    } catch (error) { status(`Could not copy report: ${error.message}`); }
  });
  downloadButton.addEventListener("click", () => {
    if (busy || closed || lastReport === null) return;
    const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = el("a");
    link.href = href;
    link.download = "project-report.json";
    link.click();
    URL.revokeObjectURL(href);
    status("Report download started.");
  });

  pathInput.addEventListener("input", () => { selectedWorkspace = ""; });
  refreshWorktrees().catch((error) => status(error.message));
  return () => {
    closed = true;
    controller.abort();
    container.replaceChildren();
  };
}

let panelCounter = 0;
