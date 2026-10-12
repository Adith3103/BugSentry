import { Router } from "express";
import mongoose from "mongoose";
import Issue, { ISSUE_SEVERITIES, ISSUE_STATUSES } from "../models/Issue.js";
import { isDatabaseReady } from "../database.js";

const createFields = new Set(["title", "description", "project", "severity"]);
const patchFields = new Set(["title", "description", "project", "severity", "status"]);

function validatePayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Request body must be a JSON object.";
  }

  const fields = partial ? patchFields : createFields;
  const unknownFields = Object.keys(payload).filter((key) => !fields.has(key));
  if (unknownFields.length) return `Unsupported field: ${unknownFields[0]}.`;
  if (partial && Object.keys(payload).length === 0) {
    return "Provide at least one issue field to update.";
  }

  for (const field of ["title", "description", "project"]) {
    if (!(field in payload)) {
      if (!partial) return `The "${field}" field is required.`;
      continue;
    }
    if (typeof payload[field] !== "string" || !payload[field].trim()) {
      return `The "${field}" field must be a nonempty string.`;
    }
    const maximum = field === "title" ? 120 : field === "description" ? 2_000 : 80;
    if (payload[field].trim().length > maximum) {
      return `The "${field}" field must be ${maximum} characters or fewer.`;
    }
  }

  if ("severity" in payload && !ISSUE_SEVERITIES.includes(payload.severity)) {
    return `Severity must be one of: ${ISSUE_SEVERITIES.join(", ")}.`;
  }
  if ("status" in payload && !ISSUE_STATUSES.includes(payload.status)) {
    return `Status must be one of: ${ISSUE_STATUSES.join(", ")}.`;
  }
  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function handleModelError(response, error, action) {
  if (error?.name === "ValidationError" || error?.name === "CastError") {
    response.status(400).json({ error: "The issue data is invalid." });
    return;
  }
  response.status(500).json({ error: `Could not ${action} the issue.` });
}

export function createIssuesRouter({ IssueModel = Issue, databaseReady = isDatabaseReady } = {}) {
  const router = Router();

  router.use((_request, response, next) => {
    if (!databaseReady()) {
      response.status(503).json({ error: "Issue storage is currently unavailable." });
      return;
    }
    next();
  });

  router.get("/", async (request, response) => {
    const { status, severity, search = "" } = request.query;
    if (status !== undefined && (typeof status !== "string" || !ISSUE_STATUSES.includes(status))) {
      response.status(400).json({ error: `Status must be one of: ${ISSUE_STATUSES.join(", ")}.` });
      return;
    }
    if (severity !== undefined && (typeof severity !== "string" || !ISSUE_SEVERITIES.includes(severity))) {
      response.status(400).json({ error: `Severity must be one of: ${ISSUE_SEVERITIES.join(", ")}.` });
      return;
    }
    if (typeof search !== "string" || search.length > 120) {
      response.status(400).json({ error: "Search must be 120 characters or fewer." });
      return;
    }

    const filter = {};
    if (status) filter.status = status;
    if (severity) filter.severity = severity;
    if (search.trim()) {
      const expression = new RegExp(escapeRegex(search.trim()), "i");
      filter.$or = [{ title: expression }, { project: expression }, { description: expression }];
    }

    try {
      const issues = await IssueModel.find(filter).sort({ createdAt: -1 });
      response.json({ issues });
    } catch {
      response.status(500).json({ error: "Could not load issues." });
    }
  });

  router.get("/:id", async (request, response) => {
    if (!mongoose.isValidObjectId(request.params.id)) {
      response.status(400).json({ error: "Issue ID is invalid." });
      return;
    }
    try {
      const issue = await IssueModel.findById(request.params.id);
      if (!issue) {
        response.status(404).json({ error: "Issue was not found." });
        return;
      }
      response.json({ issue });
    } catch {
      response.status(500).json({ error: "Could not load the issue." });
    }
  });

  router.post("/", async (request, response) => {
    const validationError = validatePayload(request.body);
    if (validationError) {
      response.status(400).json({ error: validationError });
      return;
    }
    try {
      const issue = await IssueModel.create(request.body);
      response.status(201).json({ issue });
    } catch (error) {
      handleModelError(response, error, "create");
    }
  });

  router.patch("/:id", async (request, response) => {
    if (!mongoose.isValidObjectId(request.params.id)) {
      response.status(400).json({ error: "Issue ID is invalid." });
      return;
    }
    const validationError = validatePayload(request.body, { partial: true });
    if (validationError) {
      response.status(400).json({ error: validationError });
      return;
    }
    try {
      const issue = await IssueModel.findByIdAndUpdate(request.params.id, request.body, {
        new: true,
        runValidators: true,
      });
      if (!issue) {
        response.status(404).json({ error: "Issue was not found." });
        return;
      }
      response.json({ issue });
    } catch (error) {
      handleModelError(response, error, "update");
    }
  });

  router.delete("/:id", async (request, response) => {
    if (!mongoose.isValidObjectId(request.params.id)) {
      response.status(400).json({ error: "Issue ID is invalid." });
      return;
    }
    try {
      const issue = await IssueModel.findByIdAndDelete(request.params.id);
      if (!issue) {
        response.status(404).json({ error: "Issue was not found." });
        return;
      }
      response.status(204).end();
    } catch {
      response.status(500).json({ error: "Could not delete the issue." });
    }
  });

  return router;
}
