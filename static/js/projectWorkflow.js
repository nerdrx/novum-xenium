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
  const report = el("pre");
  report.setAttribute("aria-label", "Project workflow results");
  panel.append(report);
  let lastReport = null;

  const configTitle = el("h3", "Verification checks");
  const configHelp = el("p", "Commands are saved for this repository. Run checks manually, or opt in to automatic completion checks below. Review each argv array before saving.");
  const configLabel = el("label", "Checks as JSON ");
  const config = el("textarea");
  config.rows = 7;
  config.spellcheck = false;
  config.value = JSON.stringify([
    { name: "Tests", argv: ["python", "-m", "pytest", "-q"], required: true, timeout_seconds: 120 },
  ], null, 2);
  configLabel.append(config);
  const autoRunLabel = el("label", " Run these checks automatically after agent edits ");
  const autoRun = el("input");
  autoRun.type = "checkbox";
  autoRun.checked = false;
  autoRunLabel.prepend(autoRun);
  const saveButton = button("Save checks");
  panel.append(configTitle, configHelp, configLabel, autoRunLabel, saveButton);

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
      report.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
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
            status(result.required_checks_passed ? "All required checks passed." : "Required checks did not all pass.");
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
    try { checks = JSON.parse(config.value); }
    catch { status("Checks must be valid JSON."); return; }
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
