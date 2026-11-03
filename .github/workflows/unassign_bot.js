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
const PAUSE_LABELS = [
  "awaiting review",
  "awaiting committer review",
  "awaiting change review",
  "awaiting merge"
];
const DAY = 24 * 60 * 60 * 1000;
const WARN_AFTER = 5 * DAY;
const GRACE_PERIOD = 3 * DAY;

function sameUser(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function isMaintainer(association) {
  return ["MEMBER", "OWNER", "COLLABORATOR"].includes(association);
}

module.exports = async ({github, context}) => {
  const {owner, repo} = context.repo;
  const paginate = (method, params) =>
    github.paginate(method, {owner, repo, per_page: 100, ...params});
  const comment = (issue_number, body) =>
    github.rest.issues.createComment({owner, repo, issue_number, body});

  const processed = new Set();
  let failures = 0;

  for (const label of LABELS) {
    const issues = await paginate(github.rest.issues.listForRepo, {
      state: "open",
      labels: label
    });

    for (const issue of issues) {
      if (issue.pull_request || !issue.assignees.length ||
          processed.has(issue.number)) {
        continue;
      }
      processed.add(issue.number);

      for (const {login} of issue.assignees) {
        try {
          const events = await paginate(github.rest.issues.listEventsForTimeline, {
            issue_number: issue.number
          });

          const linkedPRs = events
            .filter(event =>
              event.event === "cross-referenced" &&
              event.source?.issue?.pull_request
            )
            .map(event => event.source.issue)
            .filter(pr => sameUser(pr.user?.login, login));

          const openPRs = linkedPRs.filter(pr => pr.state === "open");

          if (openPRs.some(pr =>
            pr.labels?.some(label =>
              PAUSE_LABELS.includes(label.name.toLowerCase())
            )
          )) {
            continue;
          }

          const closedPR = linkedPRs.find(
            pr => pr.state === "closed" && !pr.pull_request.merged_at
          );

          if (closedPR) {
            await github.rest.issues.removeAssignees({
              owner, repo, issue_number: issue.number, assignees: [login]
            });
            await comment(
              issue.number,
              `This issue was automatically unassigned from @${login} because their linked pull request #${closedPR.number} was closed 
                without being merged.`
            );
            continue;
          }

          let lastActivity = Math.max(
            0,
            ...events
              .filter(event =>
                event.event === "assigned" &&
                sameUser(event.assignee?.login, login)
              )
              .map(event => Date.parse(event.created_at))
          );

          if (!lastActivity) continue;

          for (const event of events) {
            if (event.event === "commented" &&
                sameUser(event.user?.login, login)) {
              lastActivity = Math.max(lastActivity, Date.parse(event.created_at));
            }
          }

          for (const pr of openPRs) {
            const [prEvents, reviews, commits] = await Promise.all([
              paginate(github.rest.issues.listEventsForTimeline, {
                issue_number: pr.number
              }),
              paginate(github.rest.pulls.listReviewComments, {
                pull_number: pr.number
              }),
              paginate(github.rest.pulls.listCommits, {
                pull_number: pr.number
              })
            ]);

            for (const event of prEvents) {
              if (
                (["commented", "reviewed"].includes(event.event) &&
                  (sameUser(event.user?.login, login) ||
                    isMaintainer(event.author_association))) ||
                (event.event === "unlabeled" &&
                  PAUSE_LABELS.includes(event.label?.name?.toLowerCase()))
              ) {
                lastActivity = Math.max(
                  lastActivity,
                  Date.parse(event.submitted_at || event.created_at)
                );
              }
            }

            for (const review of reviews) {
              if (
                sameUser(review.user?.login, login) ||
                isMaintainer(review.author_association)
              ) {
                lastActivity = Math.max(
                  lastActivity,
                  Date.parse(review.created_at)
                );
              }
            }

            for (const commit of commits) {
              const date = Date.parse(commit.commit.author.date);
              if (sameUser(commit.author?.login, login) && Number.isFinite(date)) {
                lastActivity = Math.max(lastActivity, date);
              }
            }
          }

          if (Date.now() - lastActivity < WARN_AFTER) continue;

          const marker = `<!-- unassign-bot-warning:${login.toLowerCase()} -->`;
          const warning = events.find(event =>
            event.event === "commented" &&
            event.body?.includes(marker) &&
            Date.parse(event.created_at) >= lastActivity
          );

          if (!warning) {
            await comment(
              issue.number,
              `${marker}\n@${login}, there has been no qualifying activity for 5 days. This issue will be unassigned in 3 days unless 
                there is further activity.`
            );
          } else if (Date.now() - Date.parse(warning.created_at) >= GRACE_PERIOD) {
            await github.rest.issues.removeAssignees({
              owner, repo, issue_number: issue.number, assignees: [login]
            });
            await comment(
              issue.number,
              `This issue was automatically unassigned from @${login} due to inactivity. If you are still working on it, please comment 
                here so a maintainer can reassign it.`
            );
          }
        } catch (error) {
          failures++;
          console.error(`Failed to process #${issue.number} for ${login}`, error);
        }
      }
    }
  }

  if (failures) {
    throw new Error(`Failed to process ${failures} assignment(s).`);
  }
};
