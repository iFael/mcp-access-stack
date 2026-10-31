import type { MCP_FULL_TOOL_CATALOG_NAMES } from "./mcp-tool-catalog.js";

// What comes after each tool, in one line. It ends every tool's description and
// every successful result, so the agent is told the next call when it needs it
// instead of looking for it in the catalog. A tool without an entry does not
// compile, and an entry may name only tools of the catalog (see its test).
// An empty entry means the tool ends its job.

/** Where a published tool carries its next step, for the Edge to add it to each result. */
export const MCP_TOOL_NEXT_STEP_META_KEY = "io.github.ifael/next-step";

export type McpToolName = (typeof MCP_FULL_TOOL_CATALOG_NAMES)[number];

export const MCP_TOOL_NEXT_STEPS: Record<McpToolName, string> = {
  // Guides and workspaces
  get_operation_guide: "follow the returned steps in order; each tool's result names the call after it.",
  list_workspaces: "get_workspace_context for the workspace; list_workspace_roots first when it is an aggregate without a known root.",
  list_workspace_roots: "pass one root to get_workspace_context, list_files, search_files or inspect_workspace_git.",
  get_workspace_context: "read the instructions it returns, then list_files, search_files or read_files for the work.",
  list_files: "read_files for the files you need (up to 20 at once).",
  read_file: "patch_file with its sha256 to change it; read_files for several files.",
  read_files: "patch_files with each sha256 to change them (up to 8 at once).",
  search_files: "read_files on the paths found.",
  search_files_batch: "read_files on the paths found.",
  inspect_workspace_batch: "act on each item's result; read_files or patch_files for files it found.",
  write_file: "run_workspace_validations, then git_commit_paths when the change is done.",
  patch_file: "read_file to check it, run_workspace_validations, then git_commit_paths when the change is done.",
  patch_files: "run_workspace_validations, then git_commit_paths when the change is done.",
  delete_file: "git_commit_paths when the change is done.",
  run_workspace_validation: "fix what it reports with patch_files, then git_commit_paths.",
  run_workspace_validations: "fix what it reports with patch_files, then git_commit_paths.",
  http_get: "",

  // Commands and background tasks
  run_command: "when it answers confirmation_required, show the reasons and call again with its confirmationId; when it became a background task, wait_background_task with its taskId.",
  start_background_task: "end your answer and wait to be woken when it ends, or wait_background_task with its taskId; read_background_task_output for its output.",
  get_background_task: "while it runs, end your answer (you are woken when it ends) or wait_background_task; then read_background_task_output.",
  get_background_tasks: "wait_background_tasks for the ones still running; read_background_task_output for the ended ones.",
  wait_background_task: "still running: end your answer (you are woken when it ends) or call it again; ended: read_background_task_output for its whole output.",
  wait_background_tasks: "call it again for the ones still running; read_background_task_output for the ended ones.",
  list_background_tasks: "get_background_task or wait_background_task with a taskId.",
  cancel_background_task: "get_background_task to see it ended.",
  read_background_task_logs: "read_background_task_output with the returned offsets for more.",
  read_background_task_output: "call it again with the returned offsets while the task runs.",
  write_background_task_stdin: "read_background_task_output for its answer.",

  // Releases and the MCP update
  get_release_state: "the tool its nextStep names; mcp_update does the whole update by itself.",
  release_orchestrator: "reconcile an uncertain result with the same operationId, never dispatch again.",
  mcp_update: "end your answer; you are woken when it stops, then mcp_update action=read with the updateId.",
  prepare_release: "end your answer and wait to be woken, or wait_background_task with the taskId; then get_release_state and promote_release once the user agrees.",
  promote_release: "get_release_state until the candidate is empty (the swap may restart the connection).",
  prune_releases: "check the plan, then call it again with the plan to delete.",
  service_get_status: "service_start only when it is inactive and should run.",
  service_start: "service_get_status to see it running.",

  // Git and GitHub
  inspect_workspace_git: "git_create_branch before changing files on main; git_commit_paths for the change.",
  git_create_branch: "patch_files for the change, then git_commit_paths.",
  git_stage_paths: "git_commit.",
  git_unstage_paths: "git_stage_paths for the paths to keep.",
  git_commit: "git_push_branch.",
  git_commit_paths: "git_push_branch; on reconciliation_required, inspect_workspace_git first.",
  git_merge_branch: "git_push_branch.",
  git_sync_branch: "inspect_workspace_git to see the branch.",
  git_push_branch: "github_create_pull_request for a new branch; github_start_commit_checks_watch for its CI.",
  git_publish_tag: "github_workflow_operation for the release workflow of the tag.",
  github_get_repository: "",
  github_get_commit_checks: "pending: github_start_commit_checks_watch and end your answer, you are woken when it ends; failed: github_read kind=run_jobs and job_logs.",
  github_start_commit_checks_watch: "end your answer; you are woken when CI ends. Then github_wait_commit_checks_watch with the watchId.",
  github_get_commit_checks_watches: "github_wait_commit_checks_watch with a watchId.",
  github_wait_commit_checks_watch: "still running: end your answer, you are woken when it ends; failed: github_read kind=run_jobs and job_logs.",
  github_workflow_operation: "reconcile with the same operationId until the run is observed and completed; never dispatch again.",
  github_materialize_actions_artifact: "",
  github_create_repository: "",
  github_get_pull_request: "github_start_commit_checks_watch on its head for CI; github_read for its reviews and comments.",
  github_create_pull_request: "github_start_commit_checks_watch on its head and end your answer; you are woken when CI ends.",
  github_close_pull_request: "",
  github_merge_pull_request: "git_sync_branch to bring main up to date.",
  github_read: "nextPage for more; job_logs with a jobId from run_jobs to see why a job failed.",
  github_issue_write: "",

  // Repositories and devices
  get_current_user: "",
  get_onboarding_state: "list_repositories or list_devices.",
  list_repositories: "get_repository for one; materialize_repository to work in it.",
  get_repository: "materialize_repository or sync_repository to work in it.",
  create_repository: "materialize_repository.",
  discover_local_repositories: "import_repositories for the ones to register.",
  import_repositories: "list_workspaces to work in them.",
  materialize_repository: "list_workspaces, then get_workspace_context.",
  sync_repository: "get_workspace_context to work in it.",
  list_devices: "revoke_device only for a device the user names.",
  revoke_device: "",

  // Browser: opening and observing
  browser_status: "browser_open to begin browser work.",
  browser_connect: "browser_open.",
  browser_tabs: "browser_select_tab or browser_open with a tabId.",
  browser_select_tab: "browser_snapshot.",
  browser_open: "browser_snapshot for refs, or browser_extract to read the page.",
  browser_open_authorized_site: "call it again with the returned confirmationId once the user approves, then browser_snapshot.",
  browser_navigate: "act on the returned state; browser_snapshot when you need fresh refs.",
  browser_snapshot: "browser_click, browser_fill or browser_sequence with its refs.",
  browser_find: "browser_click or browser_fill with the returned refs.",
  browser_extract: "browser_finish_task when the browser work is done.",
  browser_frame_extract: "browser_finish_task when the browser work is done.",
  browser_profile_page: "browser_dom_index for frame refs.",
  browser_dom_index: "browser_frame_sequence with its lref_ refs.",
  browser_screenshot: "",
  browser_console: "",
  browser_network: "action=inspect with an index for one request; capture=stop when done.",
  browser_diagnostics: "",
  browser_trace: "",
  browser_video: "",
  browser_pdf: "",
  browser_download: "",

  // Browser: acting
  browser_click: "act on the returned state; browser_sequence for several known steps.",
  browser_hover: "act on the returned state.",
  browser_drag: "browser_snapshot to check the result.",
  browser_scroll: "act on the returned state.",
  browser_fill: "act on the returned state; browser_sequence for several known steps.",
  browser_form_input: "browser_snapshot to check the result.",
  browser_type: "act on the returned state.",
  browser_press: "act on the returned state.",
  browser_wait: "STATE_NOT_REACHED with forUser: call it again with forUser; reached: act on the returned state.",
  browser_sequence: "browser_snapshot before more steps after a navigation.",
  browser_frame_click: "browser_frame_extract to check the result.",
  browser_frame_fill: "browser_frame_extract to check the result.",
  browser_frame_sequence: "on confirmation_required, call it again with the confirmationId on the pending step.",
  browser_navigate_path: "browser_dom_index for refs.",
  browser_go_back: "browser_snapshot.",
  browser_go_forward: "browser_snapshot.",
  browser_dialog: "accept or dismiss it with the exact message.",
  browser_viewport: "browser_screenshot to see the page.",
  browser_upload: "browser_snapshot to check the upload.",
  browser_evaluate: "",
  browser_close_tab: "browser_finish_task when the task is done.",
  browser_finish_task: "",

  // Talking to the user
  browser_plan: "status=pending: call it again with the planId alone; approved: browser_open with the task's taskId.",
  browser_user_messages: "with options: end your answer, the choice is written into this conversation; otherwise keep working.",
  browser_user_reply: "",
  browser_progress: "browser_progress_update with the planId when a step changes.",
  browser_progress_update: "while the job goes on, end your answer with browser_progress and only the planId.",
  browser_progress_read: "",
  browser_user_card: "",
};

/** "Next: …", or "" for a tool that ends its job. */
export function mcpToolNextStep(name: string): string {
  const next = (MCP_TOOL_NEXT_STEPS as Record<string, string | undefined>)[name];
  return next ? `Next: ${next}` : "";
}

/** A tool's description, ending with its next step. */
export function withMcpToolNextStep(name: string, description: string | undefined): string | undefined {
  const next = mcpToolNextStep(name);
  if (!next) return description;
  return description ? `${description} ${next}` : next;
}
