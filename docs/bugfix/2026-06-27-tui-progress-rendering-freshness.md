# Bug Fix: TUI progress rendering freshness

## Problem

- Date: 2026-06-27
- Severity: High
- Scope: Superpowers TUI resident progress surfaces.

The bottom progress surface stayed visually unchanged while workflow activity continued. The `sidebar_content` surface showed too little context, often only a task or node label, and did not clearly show the current workflow step, recent activity, or waiting-user question.

## Root Cause

Progress capture was working: node progress events were appended to `progress.jsonl`. The display problem was in the view model and renderers:

- `renderWorkflowStatusText()` only showed durable workflow status, task counts, and running-session counts. Progress file changes did not necessarily change that text, so the bottom slot looked stale.
- `buildProgressPanelViewModel()` used the last progress entry as the row summary. The last event is often `session_status` or `session_idle`, which hides more useful text/tool progress emitted just before it.
- `renderSidebarProgressText()` had no waiting-user rendering branch, so pending questions and answer options were not surfaced in `sidebar_content`.
- Bottom workflow-status text used a short 100 character budget, so once activity was appended it could still be truncated before the useful child-session summary.

## Fix Plan

- Track both the raw latest progress entry and the latest display-worthy activity per node.
- Include latest activity and elapsed age in bottom workflow status text.
- Add waiting-user question context to the sidebar renderer.
- Expand sidebar rows with useful detail and update time while keeping the bottom line compact.
- Increase the workflow-status resident slot budget enough to keep the latest activity visible in normal task names.

## Validation

- Add unit tests for bottom freshness, waiting-user sidebar content, and session idle not hiding meaningful activity.
- Run targeted progress/TUI tests, full tests, build, e2e, package dry-run, and isolated runtime deploy.
