import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import askUser from "./src/ask-user/index.js";
import backgroundPoll from "./src/background-poll/index.js";
import claudeCode from "./src/claude-code/index.js";
import commentChecker from "./src/comment-checker/index.js";
import hashline from "./src/hashline/index.js";
import mcp from "./src/mcp/index.js";
import meridianSessionAffinity from "./src/meridian-session-affinity/index.js";
import rules from "./src/rules/index.js";
import safeRm from "./src/safe-rm/index.js";
import safetyGuard from "./src/safety-guard/index.js";
import statusPanel from "./src/status-panel/index.js";
import subAgents from "./src/sub-agents/index.js";
import webfetch from "./src/webfetch/index.js";

export default function piExtensions(pi: ExtensionAPI): void {
  askUser(pi);
  backgroundPoll(pi);
  claudeCode(pi);
  commentChecker(pi);
  hashline(pi);
  mcp(pi);
  meridianSessionAffinity(pi);
  rules(pi);
  safeRm(pi);
  safetyGuard(pi);
  statusPanel(pi);
  subAgents(pi);
  webfetch(pi);
}
