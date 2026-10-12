import mongoose from "mongoose";

export const ISSUE_STATUSES = ["Open", "In Progress", "Resolved"];
export const ISSUE_SEVERITIES = ["Critical", "High", "Medium", "Low"];

const issueSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 2_000 },
    project: { type: String, required: true, trim: true, maxlength: 80 },
    severity: { type: String, enum: ISSUE_SEVERITIES, default: "Medium" },
    status: { type: String, enum: ISSUE_STATUSES, default: "Open" },
    assignee: { type: String, trim: true, maxlength: 80, default: "AK" },
  },
  { timestamps: true, versionKey: false },
);

const Issue = mongoose.models.Issue || mongoose.model("Issue", issueSchema);

export default Issue;
