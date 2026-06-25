import { describe, expect, test } from "bun:test"
import {
  buildQuestionActions,
  filterWorkflowQuestionRequests,
  renderCompactQuestionText,
  renderQuestionBridgeText,
  renderSidebarQuestionText,
  type QuestionRequest,
} from "../src/tui/question-bridge"
import type { WorkflowState } from "../src/state/types"

const state = {
  node_runs: [
    {
      id: "001-finish",
      phase: "finish",
      agent: "sp-finisher",
      primary_skill: "superpowers-finishing-a-development-branch",
      session_id: "session-child",
      status: "running",
      attempts: 1,
      started_at: "2026-06-20T00:00:00.000Z",
    },
  ],
} as WorkflowState

const requests: QuestionRequest[] = [
  {
    id: "que_child",
    sessionID: "session-child",
    questions: [
      {
        header: "Finish action",
        question: "Implementation complete and verification passed. How would you like to finalize this work?",
        options: [
          { label: "Merge locally", description: "Merge back to the base branch." },
          { label: "Leave branch", description: "Keep the branch as-is." },
        ],
      },
    ],
  },
  {
    id: "que_other",
    sessionID: "session-other",
    questions: [
      {
        header: "Other",
        question: "Unrelated session question",
        options: [{ label: "Ignore", description: "Ignore" }],
      },
    ],
  },
]

describe("question bridge", () => {
  test("filters pending questions to active workflow child sessions", () => {
    expect(filterWorkflowQuestionRequests(state, requests).map((request) => request.id)).toEqual(["que_child"])
    expect(filterWorkflowQuestionRequests(null, requests)).toEqual([])
  })

  test("builds reply and reject actions for child question options", () => {
    const actions = buildQuestionActions([requests[0]!])
    expect(actions).toEqual([
      {
        type: "reply",
        requestID: "que_child",
        sessionID: "session-child",
        label: "Reply: Merge locally",
        description: "Finish action: Implementation complete and verification passed. How would you like to finalize this work?",
        answers: [["Merge locally"]],
      },
      {
        type: "reply",
        requestID: "que_child",
        sessionID: "session-child",
        label: "Reply: Leave branch",
        description: "Finish action: Implementation complete and verification passed. How would you like to finalize this work?",
        answers: [["Leave branch"]],
      },
      {
        type: "reject",
        requestID: "que_child",
        sessionID: "session-child",
        label: "Reject question",
        description: "Finish action: Implementation complete and verification passed. How would you like to finalize this work?",
      },
    ])
  })

  test("renders readable panel and compact question text", () => {
    const childRequests = filterWorkflowQuestionRequests(state, requests)
    expect(renderQuestionBridgeText(childRequests)).toContain("1 pending child question.")
    expect(renderQuestionBridgeText(childRequests)).toContain("Options: Merge locally / Leave branch")
    expect(renderSidebarQuestionText(childRequests)).toBe(
      "SP pending child question\nFinish action: Implementation complete and verification passed. How would you like to finalize this work?\nOptions: Merge locally / Leave branch",
    )
    expect(renderCompactQuestionText(childRequests)).toContain("SP Q: Finish action")
    expect(renderQuestionBridgeText([])).toBe("No pending child questions.")
    expect(renderSidebarQuestionText([])).toBe("")
    expect(renderCompactQuestionText([])).toBe("")
  })
})
