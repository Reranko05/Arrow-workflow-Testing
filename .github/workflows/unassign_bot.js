
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

const LABELS = ["good-first-issue", "good-second-issue"];
const DAY = 60 * 1000;
const INACTIVITY_DAYS = 1;
const INACTIVITY_PERIOD = INACTIVITY_DAYS * DAY;

// For testing, temporarily use:
// const INACTIVITY_PERIOD = 2 * 60 * 1000;

const sameUser = (a, b) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

module.exports = async ({ github, context }) => {
  const { owner, repo } = context.repo;

  /**
   * Retrieves all pages of a GitHub API response.
   *
   * @param {Function} method
   * @param {Object} params
   */
  const paginate = (method, params) =>
    github.paginate(method, { owner, repo, per_page: 100, ...params });

  /**
   * Posts a comment on the specified issue.
   *
   * @param {Number} issue_number
   * @param {String} body
   */
  const comment = (issue_number, body) =>
    github.rest.issues.createComment({ owner, repo, issue_number, body });

  /**
   * Removes the user from an issue and explains why they were unassigned.
   *
   * @param {Number} issue_number
   * @param {String} login
   * @param {String} message
   */
  const unassign = async (issue_number, login, message) => {
    await github.rest.issues.removeAssignees({
      owner,
      repo,
      issue_number,
      assignees: [login],
    });
    console.log(`Unassigned ${login} from issue #${issue_number}`);

    await comment(issue_number, message);
  };

  const processed = new Set();
  const closedPrs = [];
  const unassignedIssues = [];
  let failures = 0;

  console.log(`Checking inactive assignments in ${owner}/${repo}`);
  console.log(`Inactivity threshold: ${INACTIVITY_DAYS} days`);

  // Process each newcomer label, avoiding duplicate issues.
  for (const label of LABELS) {
    const issues = await paginate(github.rest.issues.listForRepo, {
      state: "open",
      labels: label,
    });

    console.log(`Found ${issues.length} issues with label: ${label}`);

    for (const issue of issues) {
      if (
        issue.pull_request ||
        !issue.assignees?.length ||
        processed.has(issue.number)
      ) {
        continue;
      }
      processed.add(issue.number);

      // Retrieve the timeline to determine assignments and linked PRs.
      let events;
      try {
        events = await paginate(github.rest.issues.listEventsForTimeline, {
          issue_number: issue.number,
        });
      } catch (error) {
        failures++;
        console.error(
          `Failed to retrieve timeline for issue #${issue.number}`,
          error
        );
        continue;
      }

      for (const { login } of issue.assignees) {
        try {
          // Use the most recent assignment to start the inactivity period.
          const assignedAt = Math.max(
            0,
            ...events
              .filter(
                event =>
                  event.event === "assigned" &&
                  sameUser(event.assignee?.login, login)
              )
              .map(event => Date.parse(event.created_at))
              .filter(Number.isFinite)
          );

          if (!assignedAt) {
            console.log(
              `Skipping ${login} on issue #${issue.number}: assignment event not found`
            );
            continue;
          }

          // Find the assignee's linked PR. Each contributor is expected
          // to have at most one linked PR for a particular issue.
          const linkedPr = events.find(
            event =>
              event.event === "cross-referenced" &&
              event.source?.issue?.pull_request &&
              sameUser(event.source.issue.user?.login, login)
          )?.source.issue;

          let lastActivity = assignedAt;
          let pr;

          if (linkedPr) {
            const response = await github.rest.pulls.get({
              owner,
              repo,
              pull_number: linkedPr.number,
            });
            pr = response.data;

            console.log(
              `Found linked PR #${pr.number} for issue #${issue.number} ` +
              `(author: ${pr.user?.login}, state: ${pr.state})`
            );

            // Only an open PR authored by the assignee counts as activity.
            if (
              pr.state === "open" &&
              sameUser(pr.user?.login, login)
            ) {
              const updatedAt = Date.parse(pr.updated_at);
              if (Number.isFinite(updatedAt)) {
                lastActivity = Math.max(lastActivity, updatedAt);
              }
            }
          } else {
            console.log(
              `No linked PR found for ${login} on issue #${issue.number}`
            );
          }

          const inactiveFor = Date.now() - lastActivity;

          if (inactiveFor < INACTIVITY_PERIOD) {
            console.log(
              `Keeping ${login} assigned to issue #${issue.number}: ` +
              `${Math.floor(inactiveFor / DAY)} days of inactivity`
            );
            continue;
          }

          // Close the linked PR before unassigning the contributor.
          let closedPrNumber;

          if (
            pr?.state === "open" &&
            sameUser(pr.user?.login, login)
          ) {
            await github.rest.pulls.update({
              owner,
              repo,
              pull_number: pr.number,
              state: "closed",
            });

            closedPrNumber = pr.number;
            closedPrs.push({
              issue: issue.number,
              pr: pr.number,
              assignee: login,
            });

            console.log(
              `Closed PR #${pr.number} (issue #${issue.number}, assignee: ${login})`
            );
          } else {
            console.log(
              `No open linked PR to close for issue #${issue.number} ` +
              `(assignee: ${login})`
            );
          }

          await unassign(
            issue.number,
            login,
            `@${login}, you have been automatically unassigned from this issue ` +
              `after ${INACTIVITY_DAYS} days without activity. ` +
              (closedPrNumber
                ? `Your linked PR #${closedPrNumber} has also been closed. `
                : "") +
              `If you are still interested in working on this issue, ` +
              `please ask a maintainer to reassign it and reopen your PR.`
          );

          unassignedIssues.push({
            issue: issue.number,
            assignee: login,
          });
        } catch (error) {
          failures++;
          console.error(
            `Failed to process issue #${issue.number} for ${login}`,
            error
          );
        }
      }
    }
  }

  console.log("\n--- Inactive contributor workflow summary ---");

  console.log(`Closed PRs: ${closedPrs.length}`);
  for (const { issue, pr, assignee } of closedPrs) {
    console.log(`  PR #${pr} (issue #${issue}, assignee: ${assignee})`);
  }

  console.log(`Unassignments: ${unassignedIssues.length}`);
  for (const { issue, assignee } of unassignedIssues) {
    console.log(`  Issue #${issue} (assignee: ${assignee})`);
  }

  console.log(`Failures: ${failures}`);
  console.log("--- End of summary ---");

  if (failures) {
    throw new Error(`Failed to process ${failures} assignment(s).`);
  }
};
