
// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

const COMMENT_MARKER = "<!-- arrow-ai-disclosure-check -->";
const AUTHORSHIP_HEADING = "PR code and description written by:";
const REVIEW_HEADING = "Reviewed before submission by:";

const INCOMPLETE_COMMENT = `${COMMENT_MARKER}

The AI disclosure in this pull request is missing or incomplete.

Please complete both disclosure sections in the pull request description by selecting the applicable checkboxes. Once the disclosure is complete, you can mark the pull request as ready for review.

If the disclosure is not present, add the following to the pull request description:

**PR code and description written by:**

- [ ] Human
- [ ] AI

**Reviewed before submission by:**

- [ ] Human
- [ ] AI
- [ ] Not reviewed

Once you have completed the disclosure, please manually mark this pull request as **Ready for review**.
This pull request has been converted to Draft until the disclosure is completed.`;

const AI_UNREVIEWED_COMMENT = `${COMMENT_MARKER}

This pull request has been automatically closed because its authorship is AI-only and it has no human review.

Contributions involving AI assistance are welcome. However, we require human involvement in the contribution and its review.

If this classification is incorrect, please reopen the pull request and correct the disclosure.`;

const SELF_REVIEW_COMMENT = `${COMMENT_MARKER}

This pull request has been converted to Draft because it has not been reviewed by a human.

Please review your contribution yourself before marking this pull request as ready for review.

Once you have completed your review, update the review disclosure section and mark the pull request as Ready for review.`;

const RESOLVED_COMMENT = `${COMMENT_MARKER}

The AI disclosure is now complete. No further action is required.`;

/**
 * Parses a disclosure section and returns its selected options.
 * Returns null when the section is missing, invalid, or incomplete.
 */
function parseSection(lines, start, end, options) {
  const found = new Set();
  const selected = [];

  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^\s*-\s+\[([ xX])\]\s*(.*?)\s*$/);

    if (!match) {
      if (/^\s*-\s+\[/.test(line)) return null;
      continue;
    }

    const option = match[2];
    if (!options.includes(option) || found.has(option)) return null;

    found.add(option);
    if (match[1].toLowerCase() === "x") selected.push(option);
  }

  if (
    found.size !== options.length ||
    selected.length === 0 ||
    (selected.includes("Not reviewed") && selected.length > 1)
  ) {
    return null;
  }

  return selected;
}

function normalizeHeading(line) {
  return line.trim().replace(/^\*\*(.*?)\*\*$/, "$1");
}

function isHeading(line) {
  const trimmed = line.trim();
  return /^#{1,6}\s/.test(trimmed) || /^\*\*.+\*\*$/.test(trimmed);
}

/**
 * Determines whether the disclosure is complete, requires self-review,
 * or must be closed because authorship is AI-only without human review.
 */
function parseDisclosure(body) {
  const lines = body.split(/\r?\n/);
  const headings = lines.map(normalizeHeading);
  const authorshipStart = headings.indexOf(AUTHORSHIP_HEADING);
  const reviewStart = headings.indexOf(REVIEW_HEADING);

  if (
    authorshipStart === -1 ||
    reviewStart <= authorshipStart ||
    headings.lastIndexOf(AUTHORSHIP_HEADING) !== authorshipStart ||
    headings.lastIndexOf(REVIEW_HEADING) !== reviewStart
  ) {
    return {status: "incomplete"};
  }

  const reviewEnd = lines.findIndex(
    (line, index) => index > reviewStart && isHeading(line)
  );
  const authorship = parseSection(
    lines, authorshipStart, reviewStart, ["Human", "AI"]
  );
  const review = parseSection(
    lines, reviewStart, reviewEnd === -1 ? lines.length : reviewEnd,
    ["Human", "AI", "Not reviewed"]
  );

  if (!authorship || !review) return {status: "incomplete"};
  if (review.includes("Human")) {
    return {status: "complete", authorship, review};
  }
  if (authorship.length === 1 && authorship[0] === "AI") {
    return {status: "ai-unreviewed", authorship, review};
  }

  return {status: "needs-human-review", authorship, review};
}

/**
 * Finds the bot's existing AI disclosure comment on a pull request.
 */
async function findDisclosureComment(github, context, pullRequestNumber) {
  const options = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pullRequestNumber,
    per_page: 100,
    page: 1
  };

  while (true) {
    const response = await github.rest.issues.listComments(options);
    const comment = response.data.find(
      item => item.user.type === "Bot" && item.body.includes(COMMENT_MARKER)
    );
    if (comment) return comment;
    if (!/;\s*rel="next"/.test(response.headers.link || "")) return null;
    options.page++;
  }
}

/**
 * Creates or updates the AI disclosure comment on a pull request.
 */
async function setDisclosureComment(
  github, context, pullRequestNumber, body, create = true
) {
  const existing = await findDisclosureComment(
    github, context, pullRequestNumber
  );

  if (existing) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existing.id,
      body
    });
  } else if (create) {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pullRequestNumber,
      body
    });
  }
}

/**
 * Converts the pull request to Draft unless it is already a draft.
 *
 * @param {Object} github
 * @param {Object} context
 */
async function convertToDraft(github, context) {
  if (context.payload.pull_request.draft) return;

  await github.graphql(
    `
      mutation ($pullRequestId: ID!) {
        convertPullRequestToDraft(
          input: {pullRequestId: $pullRequestId}
        ) {
          pullRequest {
            id
          }
        }
      }
    `,
    {pullRequestId: context.payload.pull_request.node_id}
  );
}

module.exports = async ({github, context}) => {
  const pullRequest = context.payload.pull_request;
  const pullRequestNumber = context.payload.number;

  if (
    pullRequest.state !== "open" ||
    (pullRequest.draft && context.payload.action !== "ready_for_review") ||
    pullRequest.user.type === "Bot"
  ) {
    return;
  }

  const result = parseDisclosure(pullRequest.body || "");

  if (result.status === "complete") {
    await setDisclosureComment(
      github, context, pullRequestNumber, RESOLVED_COMMENT, false
    );
    return;
  }

  if (result.status === "ai-unreviewed") {
    await setDisclosureComment(
      github, context, pullRequestNumber, AI_UNREVIEWED_COMMENT
    );
    await github.rest.pulls.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pullRequestNumber,
      state: "closed"
    });
    return;
  }

  await setDisclosureComment(
    github,
    context,
    pullRequestNumber,
    result.status === "incomplete" ? INCOMPLETE_COMMENT : SELF_REVIEW_COMMENT
  );
  await convertToDraft(github, context);
};
