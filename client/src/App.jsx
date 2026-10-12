import React, { useEffect, useMemo, useState } from "react";
import "./styles.css";

const navigation = [
  { label: "Overview", icon: "◫" },
  { label: "All Issues", icon: "▤" },
  { label: "My Issues", icon: "♙" },
  { label: "Projects", icon: "◈" },
];

const ANALYSIS_API_URL = (
  import.meta.env.VITE_API_URL || "http://localhost:5000"
).replace(/\/$/, "");

function issueToBug(issue) {
  const id = String(issue._id);
  return {
    id,
    displayId: `BUG-${id.slice(-6).toUpperCase()}`,
    title: issue.title,
    project: issue.project,
    severity: issue.severity,
    status: issue.status,
    assignee: issue.assignee || "AK",
    date: issue.createdAt
      ? new Date(issue.createdAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "—",
  };
}

async function issueRequest(path, options = {}) {
  const response = await fetch(`${ANALYSIS_API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(result?.error || "The issue request failed.");
  }
  return result;
}

function App() {
  const [bugs, setBugs] = useState([]);
  const [visibleBugs, setVisibleBugs] = useState([]);
  const [issuesLoading, setIssuesLoading] = useState(true);
  const [issuesError, setIssuesError] = useState("");
  const [healthStatus, setHealthStatus] = useState("checking");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [activeNav, setActiveNav] = useState("Overview");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All statuses");
  const [severityFilter, setSeverityFilter] = useState("All severities");
  const [showForm, setShowForm] = useState(false);
  const [menuBug, setMenuBug] = useState(null);
  const [formError, setFormError] = useState("");
  const [pythonCode, setPythonCode] = useState("");
  const [analysisState, setAnalysisState] = useState("idle");
  const [analysisError, setAnalysisError] = useState("");
  const [analysisDiagnostics, setAnalysisDiagnostics] = useState(null);
  const [analysisTotalIssues, setAnalysisTotalIssues] = useState(null);

  const [form, setForm] = useState({
    title: "",
    project: "Bug Management",
    severity: "Medium",
    description: "",
  });

  useEffect(() => {
    let active = true;

    async function checkHealth() {
      try {
        const response = await fetch(`${ANALYSIS_API_URL}/api/health`, {
          cache: "no-store",
        });
        const result = await response.json();
        if (!response.ok || result.status !== "ok") {
          throw new Error("Health check failed.");
        }
        if (active) setHealthStatus("healthy");
      } catch {
        if (active) setHealthStatus("unavailable");
      }
    }

    checkHealth();
    const intervalId = window.setInterval(checkHealth, 30_000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const stats = useMemo(
    () => [
      {
        label: "Total issues",
        value: bugs.length,
        note: "All reported bugs",
        icon: "▤",
        color: "purple",
      },
      {
        label: "Open issues",
        value: bugs.filter((bug) => bug.status === "Open").length,
        note: "Awaiting action",
        icon: "◷",
        color: "blue",
      },
      {
        label: "Critical issues",
        value: bugs.filter((bug) => bug.severity === "Critical").length,
        note: "Require attention",
        icon: "⚠",
        color: "red",
      },
      {
        label: "Resolved issues",
        value: bugs.filter((bug) => bug.status === "Resolved").length,
        note: "Successfully closed",
        icon: "✓",
        color: "green",
      },
    ],
    [bugs]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadIssues() {
      setIssuesLoading(true);
      setIssuesError("");
      const query = new URLSearchParams();
      if (statusFilter !== "All statuses") query.set("status", statusFilter);
      if (severityFilter !== "All severities") query.set("severity", severityFilter);
      if (search.trim()) query.set("search", search.trim());
      const suffix = query.size ? `?${query.toString()}` : "";

      try {
        const [allResult, filteredResult] = await Promise.all([
          issueRequest("/api/issues"),
          issueRequest(`/api/issues${suffix}`),
        ]);
        if (cancelled) return;
        if (!Array.isArray(allResult.issues) || !Array.isArray(filteredResult.issues)) {
          throw new Error("The issue service returned an unexpected response.");
        }
        setBugs(allResult.issues.map(issueToBug));
        const filtered = filteredResult.issues.map(issueToBug);
        setVisibleBugs(activeNav === "My Issues"
          ? filtered.filter((bug) => bug.assignee === "AK")
          : filtered);
      } catch (error) {
        if (!cancelled) setIssuesError(error.message || "Could not load issues.");
      } finally {
        if (!cancelled) setIssuesLoading(false);
      }
    }
    loadIssues();
    return () => { cancelled = true; };
  }, [search, statusFilter, severityFilter, activeNav, refreshVersion]);

  function updateForm(event) {
    const { name, value } = event.target;
    setForm((previous) => ({ ...previous, [name]: value }));
    setFormError("");
  }

  async function createBug(event) {
    event.preventDefault();

    if (!form.title.trim()) {
      setFormError("Please enter a title for the issue.");
      return;
    }

    if (!form.description.trim()) {
      setFormError("Please describe the issue before submitting.");
      return;
    }

    setFormSubmitting(true);
    setIssuesError("");
    try {
      await issueRequest("/api/issues", {
        method: "POST",
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description.trim(),
          project: form.project,
          severity: form.severity,
        }),
      });
    } catch (error) {
      setFormError(error.message || "Could not create the issue.");
      setFormSubmitting(false);
      return;
    }
    setRefreshVersion((version) => version + 1);
    setForm({
      title: "",
      project: "Bug Management",
      severity: "Medium",
      description: "",
    });
    setSearch("");
    setStatusFilter("All statuses");
    setSeverityFilter("All severities");
    setActiveNav("Overview");
    setFormError("");
    setFormSubmitting(false);
    setShowForm(false);
  }

  async function changeStatus(id, status) {
    setMenuBug(null);
    setIssuesError("");
    try {
      await issueRequest(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setRefreshVersion((version) => version + 1);
    } catch (error) {
      setIssuesError(error.message || "Could not update the issue status.");
    }
  }

  async function deleteBug(id) {
    setMenuBug(null);
    if (!window.confirm("Delete this issue permanently?")) return;
    setIssuesError("");
    try {
      await issueRequest(`/api/issues/${id}`, { method: "DELETE" });
      setRefreshVersion((version) => version + 1);
    } catch (error) {
      setIssuesError(error.message || "Could not delete the issue.");
    }
  }

function handleNavigation(label) {
  setActiveNav(label);
  setMenuBug(null);
  setSearch("");
  setStatusFilter("All statuses");
  setSeverityFilter("All severities");
}


  async function analyzePythonCode(event) {
    event.preventDefault();

    if (!pythonCode.trim()) {
      setAnalysisDiagnostics(null);
      setAnalysisTotalIssues(null);
      setAnalysisError("Enter Python code before starting the analysis.");
      setAnalysisState("error");
      return;
    }

    setAnalysisState("loading");
    setAnalysisError("");
    setAnalysisDiagnostics(null);
    setAnalysisTotalIssues(null);

    try {
      const response = await fetch(`${ANALYSIS_API_URL}/api/analyze/python`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pythonCode }),
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "The Python analysis request failed.");
      }
      if (
        !Array.isArray(result.diagnostics) ||
        !Number.isInteger(result.totalIssues) ||
        result.totalIssues !== result.diagnostics.length
      ) {
        throw new Error("The analyzer returned an unexpected response.");
      }

      setAnalysisDiagnostics(result.diagnostics);
      setAnalysisTotalIssues(result.totalIssues);
      setAnalysisState("success");
    } catch (error) {
      setAnalysisError(error.message || "Could not connect to the Python analyzer.");
      setAnalysisState("error");
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">B</div>
          <span>Bug<span className="brand-light">Sentry</span></span>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <button className="workspace-switcher" type="button">
          <span className="workspace-avatar">B</span>
          <span className="workspace-name">
            <strong>BugSentry Inc.</strong>
            <small>Free workspace</small>
          </span>
          <span className="chevron">⌄</span>
        </button>

        <div className="nav-label">MENU</div>

        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`nav-item ${
                activeNav === item.label ? "active" : ""
              }`}
              onClick={() => handleNavigation(item.label)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.label === "All Issues" && (
                <span className="nav-count">{bugs.length}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="upgrade-card">
            <div className="upgrade-icon">✦</div>
            <strong>Keep your team in sync</strong>
            <p>Stay on top of issues and ship with confidence.</p>
            <button type="button" onClick={() => alert("More workspace features coming soon.")}>
              Explore workspace <span>→</span>
            </button>
          </div>

          <button className="profile-button" type="button">
            <span className="profile-avatar">AK</span>
            <span className="profile-details">
              <strong>Adith Naik</strong>
              <small>Project Admin</small>
            </span>
            <span className="chevron">···</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{activeNav}</strong>
          </div>

          <div className="topbar-actions">
            <div className="system-status">
              <span
                className="online-dot"
                style={{
                  backgroundColor: healthStatus === "healthy"
                    ? "#4dc995"
                    : healthStatus === "unavailable"
                      ? "#fb7185"
                      : "#94a3b8",
                  boxShadow: "none",
                }}
              />
              {healthStatus === "checking"
                ? "Checking system status…"
                : healthStatus === "healthy"
                  ? "All systems operational"
                  : "Service unavailable"}
            </div>
            <button
              className="icon-button notification-button"
              type="button"
              aria-label="Notifications"
              onClick={() => alert("You're all caught up!")}
            >
              ♧
              <span className="notification-dot" />
            </button>
            <span className="top-avatar">AK</span>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-dot" />
                PROJECT WORKSPACE
              </div>
              <h1>{activeNav === "My Issues" ? "My issues" : activeNav === "Projects" ? "Projects" : activeNav === "All Issues" ? "All issues" : "Issue overview"}</h1>
              <p>Track, prioritize, and resolve issues across your workspace.</p>
            </div>

            <button
              className="primary-button"
              type="button"
              onClick={() => setShowForm(true)}
            >
              <span className="plus-icon">+</span>
              New issue
            </button>
          </section>

{activeNav === "Projects" && (
  <section className="projects-grid">
    {[
      "Bug Management",
      "Authentication",
      "Dashboard",
      "Backend API",
      "UI / UX",
    ].map((project) => {
      const projectIssues = bugs.filter(
        (bug) => bug.project === project
      );

      return (
        <article className="stat-card" key={project}>
          <div className="stat-top">
            <span className="stat-label">PROJECT</span>
            <span className="stat-icon purple">◈</span>
          </div>

          <h2>{project}</h2>

          <p>{projectIssues.length} issues</p>

          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSearch(project);
              setActiveNav("All Issues");
            }}
          >
            View issues →
          </button>
        </article>
      );
    })}
  </section>
)}
{activeNav !== "Projects" && (
  <section className="stats-grid" aria-label="Issue statistics">
    {stats.map((stat) => (
      <article className="stat-card" key={stat.label}>
        <div className="stat-top">
          <span className="stat-label">{stat.label}</span>
          <span className={`stat-icon ${stat.color}`}>
            {stat.icon}
          </span>
        </div>
        <div className="stat-value">{stat.value}</div>
        <div className="stat-note">{stat.note}</div>
      </article>
    ))}
  </section>
)}


          <section className="issues-section">
            <div className="section-heading">
              <div>
                <h2>
  {activeNav === "Overview"
    ? "Recent issues"
    : activeNav === "All Issues"
      ? "All issues"
      : activeNav === "My Issues"
        ? "Issues assigned to me"
        : "Project issues"}
</h2>
                <p>Review and manage reported issues in your workspace.</p>
              </div>
              <span className="issue-total">
                {visibleBugs.length} {visibleBugs.length === 1 ? "issue" : "issues"}
              </span>
            </div>

            <div className="filter-toolbar">
              <label className="search-box">
                <span className="search-icon">⌕</span>
                <input
                  type="search"
                  placeholder="Search issues..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="Search issues"
                />
                <kbd>⌘ K</kbd>
              </label>

              <div className="filter-controls">
                <select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  <option>All statuses</option>
                  <option>Open</option>
                  <option>In Progress</option>
                  <option>Resolved</option>
                </select>

                <select
                  aria-label="Filter by severity"
                  value={severityFilter}
                  onChange={(event) => setSeverityFilter(event.target.value)}
                >
                  <option>All severities</option>
                  <option>Critical</option>
                  <option>High</option>
                  <option>Medium</option>
                  <option>Low</option>
                </select>
              </div>
            </div>

            <div className="table-wrapper">
              <table className="issues-table">
                <thead>
                  <tr>
                    <th>ISSUE</th>
                    <th>SEVERITY</th>
                    <th>STATUS</th>
                    <th>ASSIGNEE</th>
                    <th>CREATED</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {issuesLoading && (
                    <tr><td colSpan="6" className="empty-state">Loading issues from the server...</td></tr>
                  )}
                  {!issuesLoading && issuesError && (
                    <tr>
                      <td colSpan="6" className="empty-state issues-error" role="alert">
                        <strong>Issues are unavailable</strong>
                        <p>{issuesError}</p>
                        <button type="button" onClick={() => setRefreshVersion((version) => version + 1)}>Try again</button>
                      </td>
                    </tr>
                  )}
                  {!issuesLoading && !issuesError && visibleBugs.map((bug) => (
                    <tr key={bug.id}>
                      <td>
                        <div className="issue-cell">
                          <span className="issue-symbol">◇</span>
                          <div>
                            <strong className="issue-title">{bug.title}</strong>
                            <span className="issue-meta">
                              {bug.displayId} <span>·</span> {bug.project}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`severity-badge ${bug.severity.toLowerCase()}`}>
                          <span className="badge-dot" />
                          {bug.severity}
                        </span>
                      </td>
                      <td>
                        <button
                          className={`status-badge ${bug.status.toLowerCase().replace(" ", "-")}`}
                          type="button"
                          title="Click to change status"
                          onClick={() =>
                            changeStatus(
                              bug.id,
                              bug.status === "Open"
                                ? "In Progress"
                                : bug.status === "In Progress"
                                  ? "Resolved"
                                  : "Open"
                            )
                          }
                        >
                          <span className="status-dot" />
                          {bug.status}
                        </button>
                      </td>
                      <td>
                        <div className="assignee-cell">
                          <span className={`assignee-avatar avatar-${bug.assignee.toLowerCase()}`}>
                            {bug.assignee}
                          </span>
                          <span>{bug.assignee === "AK" ? "Adith Naik" : bug.assignee === "DS" ? "Dev Shah" : bug.assignee === "RN" ? "Riya Nair" : "Maya Kumar"}</span>
                        </div>
                      </td>
                      <td className="date-cell">{bug.date}</td>
                      <td className="action-cell">
                        <button
                          className="more-button"
                          type="button"
                          aria-label={`More actions for ${bug.displayId}`}
                          onClick={() =>
                            setMenuBug(menuBug === bug.id ? null : bug.id)
                          }
                        >
                          ···
                        </button>
                        {menuBug === bug.id && (
                          <div className="action-menu">
                            <button type="button" onClick={() => changeStatus(bug.id, "Open")}>Mark open</button>
                            <button type="button" onClick={() => changeStatus(bug.id, "In Progress")}>Start progress</button>
                            <button type="button" onClick={() => changeStatus(bug.id, "Resolved")}>Mark resolved</button>
                            <button type="button" onClick={() => deleteBug(bug.id)}>Delete issue</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}

                  {!issuesLoading && !issuesError && visibleBugs.length === 0 && (
                    <tr>
                      <td colSpan="6" className="empty-state">
                        <span className="empty-icon">⌕</span>
                        <strong>No issues found</strong>
                        <p>Try another search or change your filters.</p>
                        <button
                          type="button"
                          onClick={() => {
                            setSearch("");
                            setStatusFilter("All statuses");
                            setSeverityFilter("All severities");
                            setActiveNav("Overview");
                          }}
                        >
                          Clear filters
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <footer className="table-footer">
              <span>Showing {visibleBugs.length} of {bugs.length} issues</span>
              <span className="footer-live"><span className="online-dot" /> Updated just now</span>
            </footer>
          </section>

          <section className="analyzer-section" aria-labelledby="python-analyzer-title">
            <div className="analyzer-heading">
              <div>
                <span className="analyzer-eyebrow">STATIC CODE CHECK</span>
                <h2 id="python-analyzer-title">Python Code Analyzer</h2>
                <p>Check Python syntax and a few supported issue patterns.</p>
              </div>
              <span className="analyzer-note">Your code is analyzed, never executed</span>
            </div>

            <form className="analyzer-form" onSubmit={analyzePythonCode}>
              <label htmlFor="python-source">Python code</label>
              <textarea
                id="python-source"
                className="analyzer-code-input"
                value={pythonCode}
                onChange={(event) => setPythonCode(event.target.value)}
                placeholder={'def divide(a):\n    return a / 0'}
                rows={6}
                spellCheck="false"
                aria-describedby="analyzer-help"
              />
              <div className="analyzer-controls">
                <p id="analyzer-help">
                  Checks syntax, unresolved calls, and selected division risks; it does not prove code is bug-free.
                </p>
                <button
                  className="primary-button analyzer-submit"
                  type="submit"
                  disabled={analysisState === "loading"}
                >
                  {analysisState === "loading" ? "Analyzing…" : "Analyze Code"}
                </button>
              </div>
            </form>

            <div className="analysis-results" aria-live="polite" aria-atomic="true">
              {analysisState === "idle" && (
                <p className="analysis-idle">Results will appear here after analysis.</p>
              )}
              {analysisState === "loading" && (
                <p className="analysis-loading">Analyzing Python code…</p>
              )}
              {analysisState === "error" && (
                <p className="analysis-error" role="alert">{analysisError}</p>
              )}
              {analysisState === "success" && analysisDiagnostics.length === 0 && (
                <div className="analysis-empty">
                  <strong>No supported issues detected</strong>
                  <p>This analyzer checks a limited set of patterns; this result does not prove the code is bug-free.</p>
                </div>
              )}
              {analysisState === "success" && analysisDiagnostics.length > 0 && (
                <>
                  <p className="analysis-summary" role="status">
                    {analysisTotalIssues} {analysisTotalIssues === 1 ? "issue" : "issues"} detected
                  </p>
                  <div className="diagnostic-list">
                    {analysisDiagnostics.map((diagnostic, index) => {
                      const isPotential = diagnostic.type.startsWith("potential_");
                      const diagnosticName = diagnostic.type
                        .replace(/^potential_/, "")
                        .replaceAll("_", " ");

                      return (
                        <article className="diagnostic-card" key={`${diagnostic.type}-${diagnostic.line ?? index}-${index}`}>
                          <div className="diagnostic-meta">
                            <strong className="diagnostic-type">
                              {isPotential ? `Potential issue: ${diagnosticName}` : diagnosticName}
                            </strong>
                            <span className={`diagnostic-severity ${diagnostic.severity.toLowerCase()}`}>
                              {diagnostic.severity}
                            </span>
                            {Number.isInteger(diagnostic.line) && (
                              <span className="diagnostic-line">Line {diagnostic.line}</span>
                            )}
                          </div>
                          <p>{diagnostic.explanation}</p>
                          {diagnostic.suggestedFix && (
                            <div className="diagnostic-fix">
                              <strong>Suggested fix</strong>
                              <p>{diagnostic.suggestedFix}</p>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </section>

          <footer className="page-footer">
            <span>© 2026 BugSentry</span>
            <span>Built to help teams ship better software.</span>
          </footer>
        </div>
      </main>

      {showForm && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowForm(false);
          }}
        >
          <section
            className="issue-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-issue-title"
          >
            <div className="modal-heading">
              <div>
                <span className="modal-eyebrow">BUGSENTRY WORKSPACE</span>
                <h2 id="new-issue-title">Report a new issue</h2>
                <p>Provide the details so your team can investigate.</p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowForm(false)}
                aria-label="Close form"
              >
                ×
              </button>
            </div>

            <form onSubmit={createBug}>
              <label className="form-field">
                Issue title <span>*</span>
                <input
                  name="title"
                  value={form.title}
                  onChange={updateForm}
                  placeholder="e.g. Login button does not respond"
                  maxLength={120}
                  autoFocus
                />
              </label>

              <label className="form-field">
                Project
                <select name="project" value={form.project} onChange={updateForm}>
                  <option>Bug Management</option>
                  <option>Authentication</option>
                  <option>Dashboard</option>
                  <option>Backend API</option>
                  <option>UI / UX</option>
                </select>
              </label>

              <label className="form-field">
                Severity
                <select name="severity" value={form.severity} onChange={updateForm}>
                  <option>Critical</option>
                  <option>High</option>
                  <option>Medium</option>
                  <option>Low</option>
                </select>
              </label>

              <label className="form-field">
                Description <span>*</span>
                <textarea
                  name="description"
                  value={form.description}
                  onChange={updateForm}
                  placeholder="Describe what happened and how to reproduce it..."
                  rows={4}
                  maxLength={2000}
                />
              </label>

              {formError && <p className="form-error">{formError}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setShowForm(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={formSubmitting}>
                  Create issue <span>→</span>
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
